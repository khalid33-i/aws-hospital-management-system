variable "name" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "app_role_name" {
  description = "IAM role of the app servers that may use the bucket"
  type        = string
}

variable "force_destroy" {
  description = "Allow terraform destroy to delete a non-empty bucket (dev only)"
  type        = bool
  default     = true
}