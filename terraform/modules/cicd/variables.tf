variable "name_prefix" {
  description = "Prefix for resource names, e.g. hms-dev"
  type        = string
}

variable "github_repository" {
  description = "GitHub repo allowed to deploy, format owner/name"
  type        = string
}

variable "github_environment" {
  description = "GitHub Environment name that the deploy job runs in"
  type        = string
  default     = "production"
}

variable "asg_name" {
  description = "Name of the Auto Scaling Group the pipeline may refresh"
  type        = string
}