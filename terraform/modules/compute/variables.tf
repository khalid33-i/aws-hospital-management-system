variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "private_app_subnet_ids" {
  type = list(string)
}

variable "alb_sg_id" {
  type = string
}

variable "app_sg_id" {
  type = string
}

variable "instance_profile_name" {
  type = string
}

variable "app_role_name" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "db_host" {
  type = string
}

variable "db_name" {
  type = string
}

variable "db_secret_arn" {
  type = string
}

variable "instance_type" {
  type    = string
  default = "t3.micro"
}

variable "min_size" {
  type    = number
  default = 1
}

variable "desired_size" {
  type    = number
  default = 1
}

variable "max_size" {
  type    = number
  default = 2
}

variable "git_repo_url" {
  type    = string
  default = "https://github.com/khalid33-i/aws-hospital-management-system.git"
}

variable "git_ref" {
  description = "Branch or tag the servers deploy"
  type        = string
  default     = "main"
}

variable "app_port" {
  type    = number
  default = 3000
}