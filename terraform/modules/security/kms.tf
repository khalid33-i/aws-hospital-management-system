resource "aws_kms_key" "main" {
  description             = "${var.name} encryption key (S3, RDS)"
  enable_key_rotation     = true
  deletion_window_in_days = 7
}

resource "aws_kms_alias" "main" {
  name          = "alias/${var.name}"
  target_key_id = aws_kms_key.main.key_id
}