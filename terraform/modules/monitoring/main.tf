data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# ---------- Notifications: alarms -> SNS -> email ----------
resource "aws_sns_topic" "alerts" {
  name = "${var.name}-alerts"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# ---------- Alarms (one definition, one alarm per entry) ----------
locals {
  alb_dims = tomap({
    LoadBalancer = var.alb_arn_suffix
    TargetGroup  = var.target_group_arn_suffix
  })

  alarms = {
    ec2-cpu-high = {
      description         = "Average CPU of the app servers is above 70% for 10 minutes"
      namespace           = "AWS/EC2"
      metric_name         = "CPUUtilization"
      dimensions          = tomap({ AutoScalingGroupName = var.asg_name })
      statistic           = "Average"
      period              = 300
      evaluation_periods  = 2
      comparison_operator = "GreaterThanThreshold"
      threshold           = 70
      treat_missing_data  = "notBreaching"
    }
    ec2-memory-high = {
      description         = "Memory used on the app servers is above 80%"
      namespace           = "CWAgent"
      metric_name         = "mem_used_percent"
      dimensions          = tomap({ AutoScalingGroupName = var.asg_name })
      statistic           = "Average"
      period              = 300
      evaluation_periods  = 2
      comparison_operator = "GreaterThanThreshold"
      threshold           = 80
      treat_missing_data  = "notBreaching"
    }
    ec2-disk-high = {
      description         = "Root disk of an app server is more than 80% full"
      namespace           = "CWAgent"
      metric_name         = "disk_used_percent"
      dimensions          = tomap({ AutoScalingGroupName = var.asg_name })
      statistic           = "Maximum"
      period              = 300
      evaluation_periods  = 1
      comparison_operator = "GreaterThanThreshold"
      threshold           = 80
      treat_missing_data  = "notBreaching"
    }
    asg-no-instances = {
      description         = "The Auto Scaling group has no instance in service"
      namespace           = "AWS/AutoScaling"
      metric_name         = "GroupInServiceInstances"
      dimensions          = tomap({ AutoScalingGroupName = var.asg_name })
      statistic           = "Minimum"
      period              = 60
      evaluation_periods  = 2
      comparison_operator = "LessThanThreshold"
      threshold           = 1
      treat_missing_data  = "breaching"
    }
    app-no-healthy-hosts = {
      description         = "Application unavailable: the load balancer has no healthy target"
      namespace           = "AWS/ApplicationELB"
      metric_name         = "HealthyHostCount"
      dimensions          = local.alb_dims
      statistic           = "Minimum"
      period              = 60
      evaluation_periods  = 2
      comparison_operator = "LessThanThreshold"
      threshold           = 1
      treat_missing_data  = "breaching"
    }
    alb-unhealthy-hosts = {
      description         = "At least one target is failing health checks"
      namespace           = "AWS/ApplicationELB"
      metric_name         = "UnHealthyHostCount"
      dimensions          = local.alb_dims
      statistic           = "Maximum"
      period              = 60
      evaluation_periods  = 2
      comparison_operator = "GreaterThanOrEqualToThreshold"
      threshold           = 1
      treat_missing_data  = "notBreaching"
    }
    alb-target-5xx = {
      description         = "The application returned more than 10 server errors in 5 minutes"
      namespace           = "AWS/ApplicationELB"
      metric_name         = "HTTPCode_Target_5XX_Count"
      dimensions          = tomap({ LoadBalancer = var.alb_arn_suffix })
      statistic           = "Sum"
      period              = 300
      evaluation_periods  = 1
      comparison_operator = "GreaterThanThreshold"
      threshold           = 10
      treat_missing_data  = "notBreaching"
    }
    rds-cpu-high = {
      description         = "Database CPU is above 80% for 10 minutes"
      namespace           = "AWS/RDS"
      metric_name         = "CPUUtilization"
      dimensions          = tomap({ DBInstanceIdentifier = var.db_instance_id })
      statistic           = "Average"
      period              = 300
      evaluation_periods  = 2
      comparison_operator = "GreaterThanThreshold"
      threshold           = 80
      treat_missing_data  = "notBreaching"
    }
    rds-connections-high = {
      description         = "Database connections are above 40"
      namespace           = "AWS/RDS"
      metric_name         = "DatabaseConnections"
      dimensions          = tomap({ DBInstanceIdentifier = var.db_instance_id })
      statistic           = "Average"
      period              = 300
      evaluation_periods  = 2
      comparison_operator = "GreaterThanThreshold"
      threshold           = 40
      treat_missing_data  = "notBreaching"
    }
    rds-storage-low = {
      description         = "Database free storage is below 2 GiB"
      namespace           = "AWS/RDS"
      metric_name         = "FreeStorageSpace"
      dimensions          = tomap({ DBInstanceIdentifier = var.db_instance_id })
      statistic           = "Minimum"
      period              = 300
      evaluation_periods  = 1
      comparison_operator = "LessThanThreshold"
      threshold           = 2147483648
      treat_missing_data  = "notBreaching"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "this" {
  for_each = local.alarms

  alarm_name          = "${var.name}-${each.key}"
  alarm_description   = each.value.description
  namespace           = each.value.namespace
  metric_name         = each.value.metric_name
  dimensions          = each.value.dimensions
  statistic           = each.value.statistic
  period              = each.value.period
  evaluation_periods  = each.value.evaluation_periods
  comparison_operator = each.value.comparison_operator
  threshold           = each.value.threshold
  treat_missing_data  = each.value.treat_missing_data

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}