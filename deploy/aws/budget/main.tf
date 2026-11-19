# Applied first and destroyed last by deploy/aws/atalaya-aws.sh: the spend alarm exists before
# anything that costs money, and outlives it. A budget alerts; it does not stop spending (teardown does).
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags { tags = { Project = "atalaya", ManagedBy = "terraform" } }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "monthly_limit_usd" {
  type        = number
  description = "Monthly cost budget for the whole account (USD)."
  validation {
    condition     = var.monthly_limit_usd > 0 && var.monthly_limit_usd <= 200
    error_message = "Pick a limit between 1 and 200 USD: this is a demo deployment."
  }
}

variable "alert_email" {
  type        = string
  description = "Where budget alerts go. Never committed: passed by the deploy script from the environment."
  sensitive   = true
}

resource "aws_budgets_budget" "atalaya" {
  name         = "atalaya-demo"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Early warnings on actual spend, and one on the forecast so a forgotten stack is caught mid-month.
  dynamic "notification" {
    for_each = [25, 50, 80, 100]
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.alert_email]
    }
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}

output "budget_name" { value = aws_budgets_budget.atalaya.name }
