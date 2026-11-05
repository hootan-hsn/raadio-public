# Most values describe the server as it already exists. discover.sh reads them
# from AWS and writes terraform.tfvars, so Terraform adopts the server without
# replacing anything. Change them only on purpose.

variable "region" {
  description = "AWS region of the server (us-east-2 = Ohio)"
  type        = string
  default     = "us-east-2"
}

variable "name" {
  description = "Name tag of the server"
  type        = string
  default     = "raadio"
}

# ---- The server ------------------------------------------------------------
variable "instance_type" {
  description = "EC2 size. Changing it restarts the server (about a minute of silence)."
  type        = string
}

variable "ami_id" {
  description = "Image the server was created from. Ignored after import (changing it would rebuild the server)."
  type        = string
}

variable "key_name" {
  description = "SSH key pair the server was created with"
  type        = string
}

variable "subnet_id" {
  type = string
}

variable "root_volume_size" {
  description = "Disk size in GB. Can only grow. After growing, extend the filesystem on the server (growpart + resize2fs)."
  type        = number
}

variable "root_volume_type" {
  type    = string
  default = "gp3"
}

# ---- Firewall (security group) --------------------------------------------
variable "vpc_id" {
  type = string
}

variable "sg_name" {
  description = "Existing security group name (can't change without replacing the group)"
  type        = string
}

variable "sg_description" {
  description = "Existing security group description (same: AWS can't edit it)"
  type        = string
}

variable "extra_security_group_ids" {
  description = "Other security groups already on the server; kept attached, not managed here"
  type        = list(string)
  default     = []
}

variable "ssh_cidrs" {
  description = "Who may SSH in. GitHub Actions deploys over SSH, so this stays open; the server only accepts keys."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

# ---- Alerts ------------------------------------------------------------------
variable "alert_email" {
  description = "Email for the monthly cost alert. Leave empty for no alert."
  type        = string
  default     = ""
}

variable "monthly_budget_usd" {
  description = "Send an email when the month's AWS bill reaches 80% of this, or is forecast to pass it"
  type        = number
  default     = 10
}
