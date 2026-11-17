output "account_id" {
  value = data.aws_caller_identity.current.account_id
}

output "budget_name" {
  value = aws_budgets_budget.monthly.name
}

output "vpc_id" {
  value = module.networking.vpc_id
}

output "public_subnet_ids" {
  value = module.networking.public_subnet_ids
}

output "private_app_subnet_ids" {
  value = module.networking.private_app_subnet_ids
}

output "private_db_subnet_ids" {
  value = module.networking.private_db_subnet_ids
}

output "alb_sg_id" {
  value = module.security.alb_sg_id
}

output "app_sg_id" {
  value = module.security.app_sg_id
}

output "db_sg_id" {
  value = module.security.db_sg_id
}

output "documents_bucket" {
  value = module.storage.bucket_name
}

output "db_endpoint" {
  value = module.database.endpoint
}
output "app_url" {
  value = "http://${module.compute.alb_dns_name}"
}

output "asg_name" {
  value = module.compute.asg_name
}
output "dashboard_name" {
  value = module.monitoring.dashboard_name
}
output "github_deploy_role_arn" {
  value = module.cicd.deploy_role_arn
}