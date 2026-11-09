data "aws_caller_identity" "current" {}

resource "aws_budgets_budget" "monthly" {
  name         = "hms-${var.environment}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Free Plan credits would hide real usage (cost shows as $0).
  # Exclude them so the budget tracks what we would be paying without credits.
  cost_types {
    include_credit = false
    include_refund = false
  }

  # 20% of $5 = $1, then 60% and 100%
  dynamic "notification" {
    for_each = [20, 60, 100]
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

data "aws_availability_zones" "available" {
  state = "available"
}

module "networking" {
  source = "../../modules/networking"

  name = "hms-${var.environment}"
  azs  = slice(data.aws_availability_zones.available.names, 0, 2)
}

module "security" {
  source = "../../modules/security"

  name   = "hms-${var.environment}"
  vpc_id = module.networking.vpc_id
}

module "storage" {
  source = "../../modules/storage"

  name          = "hms-${var.environment}"
  kms_key_arn   = module.security.kms_key_arn
  app_role_name = module.security.app_role_name
}