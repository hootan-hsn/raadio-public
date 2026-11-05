# Raadio's AWS infrastructure: one EC2 server with a fixed address and a firewall.
#
# These resources already existed before Terraform; imports.tf (written by
# discover.sh) adopts them. prevent_destroy makes Terraform refuse any plan that
# would delete the server, its address or its firewall.

# ---- Firewall --------------------------------------------------------------
resource "aws_security_group" "radio" {
  name        = var.sg_name
  description = var.sg_description
  vpc_id      = var.vpc_id

  # Rules have no descriptions on purpose: these match the rules the server already
  # has, and AWS can't edit a description in place (Terraform would delete and
  # re-add the rule, briefly blocking new connections).

  # SSH (keys only; GitHub Actions deploys this way)
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.ssh_cidrs
  }

  # HTTP (redirects to HTTPS; Certbot renewals)
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTPS (website, streams, API)
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Icecast (8000) and the controller (8080) are NOT open: Nginx reaches them on
  # 127.0.0.1. Any old rule for those ports is removed by this config.

  # All outbound (Telegram, GitHub, package updates)
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.name}-firewall"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# ---- Server ----------------------------------------------------------------
resource "aws_instance" "radio" {
  ami                    = var.ami_id
  instance_type          = var.instance_type
  key_name               = var.key_name
  subnet_id              = var.subnet_id
  vpc_security_group_ids = concat([aws_security_group.radio.id], var.extra_security_group_ids)

  root_block_device {
    volume_size = var.root_volume_size
    volume_type = var.root_volume_type
    tags = {
      Name = "${var.name}-disk"
    }
  }

  tags = {
    Name = var.name
  }

  lifecycle {
    prevent_destroy = true
    # Things that would rebuild the server (and lose everything on it) if they
    # ever differed. The server is configured by Git + Docker, not by Terraform.
    ignore_changes = [
      ami,
      key_name,
      user_data,
      user_data_base64,
      associate_public_ip_address,
      root_block_device[0].encrypted,
      root_block_device[0].kms_key_id,
    ]
  }
}

# ---- Fixed public address (the DNS for raadio.run.place points here) --------
resource "aws_eip" "radio" {
  domain   = "vpc"
  instance = aws_instance.radio.id

  tags = {
    Name = "${var.name}-ip"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# ---- Self-healing: if AWS's hardware under the server fails, move it --------
# Recovery keeps the same disk, address and data. CloudWatch's free tier covers it.
resource "aws_cloudwatch_metric_alarm" "recover" {
  alarm_name          = "${var.name}-auto-recover"
  alarm_description   = "Recover the Raadio server when AWS's system status check fails"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_System"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  dimensions = {
    InstanceId = aws_instance.radio.id
  }
  alarm_actions = ["arn:aws:automate:${var.region}:ec2:recover"]
}

# ---- Optional cost alert ---------------------------------------------------
resource "aws_budgets_budget" "monthly" {
  count        = var.alert_email == "" ? 0 : 1
  name         = "${var.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}
