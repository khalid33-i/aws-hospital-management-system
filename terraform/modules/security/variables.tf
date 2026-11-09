variable "name" {
  description = "Prefix for resource names"
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "app_port" {
  description = "Port the Node.js app listens on"
  type        = number
  default     = 3000
}

variable "db_port" {
  type    = number
  default = 3306
}