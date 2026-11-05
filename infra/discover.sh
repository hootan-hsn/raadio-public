#!/usr/bin/env bash
# Run once in AWS CloudShell, from the infra/ folder:
#   bash discover.sh [ELASTIC_IP]
#
# Looks up the Raadio server by its Elastic IP (read-only), then writes:
#   terraform.tfvars  the server's current settings, so Terraform changes nothing
#   imports.tf        tells Terraform to adopt the existing server, firewall and IP
#   backend.hcl       where Terraform keeps its state (a private S3 bucket)
# and creates that S3 bucket if it doesn't exist yet (versioned, not public).
set -euo pipefail

IP="${1:-3.21.217.155}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-2}}"
export AWS_DEFAULT_REGION="$REGION"
cd "$(dirname "$0")"

for tool in aws jq; do
  command -v "$tool" >/dev/null || { echo "Needs '$tool' (AWS CloudShell has both)." >&2; exit 1; }
done

echo "==> Looking for the server with address $IP in $REGION"
INST="$(aws ec2 describe-instances --filters "Name=ip-address,Values=$IP" \
          --query 'Reservations[0].Instances[0]' --output json)"
if [ -z "$INST" ] || [ "$INST" = "null" ]; then
  echo "No server found with public address $IP in $REGION." >&2
  echo "Check the address and region (AWS_REGION=... bash discover.sh <ip>)." >&2
  exit 1
fi

j() { jq -r "$1" <<<"$INST"; }
INSTANCE_ID="$(j '.InstanceId')"
INSTANCE_TYPE="$(j '.InstanceType')"
AMI_ID="$(j '.ImageId')"
KEY_NAME="$(j '.KeyName // ""')"
SUBNET_ID="$(j '.SubnetId')"
VPC_ID="$(j '.VpcId')"
NAME_TAG="$(j '[.Tags[]? | select(.Key=="Name") | .Value][0] // "raadio"')"
ROOT_DEV="$(j '.RootDeviceName')"
VOLUME_ID="$(jq -r --arg d "$ROOT_DEV" '.BlockDeviceMappings[] | select(.DeviceName==$d) | .Ebs.VolumeId' <<<"$INST")"
mapfile -t SG_IDS < <(j '.SecurityGroups[].GroupId')

VOL="$(aws ec2 describe-volumes --volume-ids "$VOLUME_ID" --query 'Volumes[0]' --output json)"
VOLUME_SIZE="$(jq -r '.Size' <<<"$VOL")"
VOLUME_TYPE="$(jq -r '.VolumeType' <<<"$VOL")"

ALLOC_ID="$(aws ec2 describe-addresses --public-ips "$IP" --query 'Addresses[0].AllocationId' --output text 2>/dev/null || true)"
if [ -z "$ALLOC_ID" ] || [ "$ALLOC_ID" = "None" ]; then
  echo "$IP is not an Elastic IP in this account/region." >&2
  exit 1
fi

# The firewall to manage: the attached group that allows SSH (others stay attached, untouched)
SGS="$(aws ec2 describe-security-groups --group-ids "${SG_IDS[@]}" --output json)"
MAIN_SG="$(jq -r '[.SecurityGroups[] | select(any(.IpPermissions[]?; (.FromPort // -1) <= 22 and (.ToPort // -1) >= 22))][0].GroupId // empty' <<<"$SGS")"
[ -n "$MAIN_SG" ] || MAIN_SG="${SG_IDS[0]}"
SG_NAME="$(jq -r --arg g "$MAIN_SG" '.SecurityGroups[] | select(.GroupId==$g) | .GroupName' <<<"$SGS")"
SG_DESC="$(jq -r --arg g "$MAIN_SG" '.SecurityGroups[] | select(.GroupId==$g) | .Description' <<<"$SGS")"
EXTRA_SGS="$(printf '%s\n' "${SG_IDS[@]}" | { grep -vx "$MAIN_SG" || true; } | jq -R . | jq -s -c . )"
OPEN_PORTS="$(jq -r --arg g "$MAIN_SG" '.SecurityGroups[] | select(.GroupId==$g) | [.IpPermissions[] | (if .FromPort == null then "all" elif .FromPort == .ToPort then (.FromPort|tostring) else "\(.FromPort)-\(.ToPort)" end) + "/" + (.IpProtocol|sub("-1";"any"))] | join(", ")' <<<"$SGS")"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="raadio-tfstate-${ACCOUNT_ID}"

cat <<EOF
    Server:     $INSTANCE_ID ($INSTANCE_TYPE, name "$NAME_TAG")
    Disk:       $VOLUME_ID, ${VOLUME_SIZE} GB $VOLUME_TYPE
    Address:    $IP ($ALLOC_ID)
    Firewall:   $MAIN_SG "$SG_NAME", open now: $OPEN_PORTS
    Other SGs:  $EXTRA_SGS
EOF

# ---- terraform.tfvars ------------------------------------------------------
tfstr() { jq -Rn --arg v "$1" '$v'; }      # a safely quoted string
{
  echo "# Written by discover.sh from the live server on $(date -u +%Y-%m-%dT%H:%MZ)."
  echo "region                   = $(tfstr "$REGION")"
  echo "name                     = $(tfstr "$NAME_TAG")"
  echo "instance_type            = $(tfstr "$INSTANCE_TYPE")"
  echo "ami_id                   = $(tfstr "$AMI_ID")"
  echo "key_name                 = $(tfstr "$KEY_NAME")"
  echo "subnet_id                = $(tfstr "$SUBNET_ID")"
  echo "vpc_id                   = $(tfstr "$VPC_ID")"
  echo "root_volume_size         = $VOLUME_SIZE"
  echo "root_volume_type         = $(tfstr "$VOLUME_TYPE")"
  echo "sg_name                  = $(tfstr "$SG_NAME")"
  echo "sg_description           = $(tfstr "$SG_DESC")"
  echo "extra_security_group_ids = $EXTRA_SGS"
  echo
  echo "# Optional: an email for a monthly cost alert (you'll get a confirmation email first)"
  echo "alert_email        = \"\""
  echo "monthly_budget_usd = 10"
} > terraform.tfvars

# ---- imports.tf --------------------------------------------------------------
cat > imports.tf <<EOF
# Written by discover.sh: adopt the existing resources instead of creating new ones.
import {
  to = aws_instance.radio
  id = "$INSTANCE_ID"
}

import {
  to = aws_security_group.radio
  id = "$MAIN_SG"
}

import {
  to = aws_eip.radio
  id = "$ALLOC_ID"
}
EOF

# ---- state bucket + backend.hcl ----------------------------------------------
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "==> State bucket $BUCKET already exists"
else
  echo "==> Creating the private state bucket $BUCKET"
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
  aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi

cat > backend.hcl <<EOF
bucket       = "$BUCKET"
key          = "raadio/terraform.tfstate"
region       = "$REGION"
encrypt      = true
use_lockfile = true
EOF

echo "==> Wrote terraform.tfvars, imports.tf and backend.hcl"
echo "    Next:  terraform init -backend-config=backend.hcl  &&  terraform plan"
