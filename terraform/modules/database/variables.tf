variable "name" {
  type = string
}

variable "subnet_ids" {
  description = "Private DB subnets (at least two AZs)"
  type        = list(string)
}

variable "security_group_id" {
  description = "DB security group"
  type        = string
}

variable "kms_key_arn" {
  type = string
}

variable "app_role_name" {
  description = "App servers role that may read the DB secret"
  type        = string
}

variable "instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "allocated_storage" {
  type    = number
  default = 20
}

variable "multi_az" {
  type    = bool
  default = false
}

variable "backup_retention_days" {
  type    = number
  default = 7
}

variable "deletion_protection" {
  description = "true in production; false in dev so terraform destroy works"
  type        = bool
  default     = false
}

variable "skip_final_snapshot" {
  description = "false in production so a final snapshot is taken on delete"
  type        = bool
  default     = true
}