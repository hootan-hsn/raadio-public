terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }

  # State lives in a private, versioned S3 bucket (made by discover.sh).
  # The bucket name is account-specific, so it comes from backend.hcl:
  #   terraform init -backend-config=backend.hcl
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "raadio"
      ManagedBy = "terraform"
    }
  }
}
