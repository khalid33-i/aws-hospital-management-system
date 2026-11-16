data "aws_region" "current" {}

# Latest Amazon Linux 2023 image, resolved by AWS
data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

# ---------- Secret used to sign login tokens (every server must share the same one) ----------
resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "aws_ssm_parameter" "jwt_secret" {
  name   = "/${var.name}/jwt-secret"
  type   = "SecureString"
  key_id = var.kms_key_arn
  value  = random_password.jwt.result
}

data "aws_iam_policy_document" "read_params" {
  statement {
    sid       = "ReadJwtSecret"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.jwt_secret.arn]
  }

  statement {
    sid       = "DecryptWithProjectKey"
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_role_policy" "read_params" {
  name   = "${var.name}-read-jwt-secret"
  role   = var.app_role_name
  policy = data.aws_iam_policy_document.read_params.json
}

# ---------- Application log group (the CloudWatch agent ships /var/log/hms/app.log here) ----------
resource "aws_cloudwatch_log_group" "app" {
  name              = "/${var.name}/app"
  retention_in_days = 7
}

# ---------- Launch template: how every app server is built ----------
resource "aws_launch_template" "app" {
  name_prefix   = "${var.name}-app-"
  image_id      = data.aws_ssm_parameter.al2023_ami.value
  instance_type = var.instance_type

  iam_instance_profile {
    name = var.instance_profile_name
  }

  vpc_security_group_ids = [var.app_sg_id]

  # IMDSv2 only (blocks credential theft through SSRF)
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      volume_size           = 8
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  user_data = base64encode(templatefile("${path.module}/user_data.sh.tftpl", {
    region        = data.aws_region.current.region
    git_repo      = var.git_repo_url
    git_ref       = var.git_ref
    db_host       = var.db_host
    db_name       = var.db_name
    db_secret_arn = var.db_secret_arn
    jwt_param     = aws_ssm_parameter.jwt_secret.name
    app_port      = var.app_port
    log_group     = aws_cloudwatch_log_group.app.name
  }))

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${var.name}-app" }
  }

  tag_specifications {
    resource_type = "volume"
    tags          = { Name = "${var.name}-app" }
  }

  lifecycle {
    create_before_destroy = true
  }
}

# ---------- Application Load Balancer ----------
resource "aws_lb" "this" {
  name                       = "${var.name}-alb"
  load_balancer_type         = "application"
  security_groups            = [var.alb_sg_id]
  subnets                    = var.public_subnet_ids
  drop_invalid_header_fields = true

  tags = { Name = "${var.name}-alb" }
}

resource "aws_lb_target_group" "app" {
  name                 = "${var.name}-tg"
  port                 = var.app_port
  protocol             = "HTTP"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Name = "${var.name}-tg" }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# ---------- Auto Scaling Group ----------
resource "aws_autoscaling_group" "app" {
  name                      = "${var.name}-asg"
  min_size                  = var.min_size
  desired_capacity          = var.desired_size
  max_size                  = var.max_size
  vpc_zone_identifier       = var.private_app_subnet_ids
  target_group_arns         = [aws_lb_target_group.app.arn]
  health_check_type         = "ELB"
  health_check_grace_period = 420

  # Group metrics (used by the "no instance in service" alarm)
  metrics_granularity = "1Minute"
  enabled_metrics     = ["GroupInServiceInstances", "GroupDesiredCapacity", "GroupTotalInstances"]

  launch_template {
    id      = aws_launch_template.app.id
    version = aws_launch_template.app.latest_version
  }

  # A new launch template version replaces servers gradually, new one first, then the old one
  instance_refresh {
    strategy = "Rolling"

    preferences {
      min_healthy_percentage = 100
      max_healthy_percentage = 200
    }
  }

  tag {
    key                 = "Name"
    value               = "${var.name}-app"
    propagate_at_launch = true
  }

  depends_on = [aws_iam_role_policy.read_params]
}

# Add a server when average CPU stays above 50%, remove one when it drops
resource "aws_autoscaling_policy" "cpu" {
  name                   = "${var.name}-cpu-target"
  autoscaling_group_name = aws_autoscaling_group.app.name
  policy_type            = "TargetTrackingScaling"

  target_tracking_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ASGAverageCPUUtilization"
    }
    target_value = 50
  }
}