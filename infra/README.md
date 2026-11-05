# Raadio infrastructure (Terraform)

What it manages, all in us-east-2 (Ohio):

| Resource | Notes |
|---|---|
| EC2 server | size, disk size (20 GB gp3), firewall attachment, tags. Never rebuilt: AMI, key and user data are ignored, and `prevent_destroy` blocks deletion. |
| Firewall (security group) | only 22, 80, 443 open. Icecast (8000) and the API (8080) stay private. |
| Elastic IP | the fixed address `raadio.run.place` points to (DNS is at DNSExit, not here). |
| Auto-recover alarm | if AWS's hardware under the server fails, the server is moved, same disk and IP. |
| Cost alert (optional) | email at 80% of a monthly budget, or when the forecast passes it. |

State is kept in a private, versioned S3 bucket (`raadio-tfstate-<account id>`)
with locking, so it's safe to run from anywhere.

## First run: adopt the existing server (AWS CloudShell)

1. AWS Console, region **Ohio (us-east-2)**, open **CloudShell** (the `>_` icon at the top).
2. Install Terraform (once; CloudShell keeps your home folder):
   ```bash
   mkdir -p ~/bin && cd ~/bin
   ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
   curl -fsSLo tf.zip "https://releases.hashicorp.com/terraform/1.10.5/terraform_1.10.5_linux_${ARCH}.zip"
   unzip -o tf.zip terraform && rm tf.zip
   grep -q 'HOME/bin' ~/.bashrc || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
   export PATH="$HOME/bin:$PATH"; cd ~
   terraform -version
   ```
3. **Actions > Upload file**, upload `raadio-infra.zip`, then:
   ```bash
   unzip -o raadio-infra.zip && cd raadio-infra/infra
   bash discover.sh               # read-only lookup; creates the state bucket
   terraform init -backend-config=backend.hcl
   terraform plan -out=tfplan
   ```
4. Check the plan says **0 to destroy**, then `terraform apply tfplan`.

## Later changes

Edit the `.tf` files (or `terraform.tfvars` in CloudShell), then `terraform plan`
and `terraform apply`. For example, a bigger disk: set `root_volume_size = 30`,
apply, then on the server `sudo growpart /dev/nvme0n1 1 && sudo resize2fs /dev/nvme0n1p1`.
