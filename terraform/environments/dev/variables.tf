variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "eu-central-1"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "dev"
}

variable "alert_email" {
  description = "Email that receives budget alerts"
  type        = string
}

variable "monthly_budget_usd" {
  description = "Monthly budget in USD"
  type        = number
  default     = 5
}