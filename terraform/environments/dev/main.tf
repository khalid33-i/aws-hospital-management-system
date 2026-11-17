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


module "database" {
  source = "../../modules/database"

  name                  = "hms-${var.environment}"
  subnet_ids            = module.networking.private_db_subnet_ids
  security_group_id     = module.security.db_sg_id
  kms_key_arn           = module.security.kms_key_arn
  app_role_name         = module.security.app_role_name
  backup_retention_days = 1
}

module "compute" {
  source = "../../modules/compute"

  # wait for the NAT route and the database (and its secret policy) before servers boot
  depends_on = [module.networking, module.database]

  name                   = "hms-${var.environment}"
  vpc_id                 = module.networking.vpc_id
  public_subnet_ids      = module.networking.public_subnet_ids
  private_app_subnet_ids = module.networking.private_app_subnet_ids
  alb_sg_id              = module.security.alb_sg_id
  app_sg_id              = module.security.app_sg_id
  instance_profile_name  = module.security.app_instance_profile_name
  app_role_name          = module.security.app_role_name
  kms_key_arn            = module.security.kms_key_arn
  db_host                = module.database.endpoint
  db_name                = module.database.db_name
  db_secret_arn          = module.database.master_secret_arn
}

module "monitoring" {
  source = "../../modules/monitoring"

  name                    = "hms-${var.environment}"
  alert_email             = var.alert_email
  asg_name                = module.compute.asg_name
  alb_arn_suffix          = module.compute.alb_arn_suffix
  target_group_arn_suffix = module.compute.target_group_arn_suffix
  db_instance_id          = module.database.instance_id
}
module "cicd" {
  source = "../../modules/cicd"

  name_prefix       = "hms-${var.environment}"
  github_repository = "khalid33-i/aws-hospital-management-system"
  asg_name          = module.compute.asg_name
}