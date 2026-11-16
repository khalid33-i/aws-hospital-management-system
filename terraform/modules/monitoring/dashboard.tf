resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${var.name}-overview"

  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 8, height = 6
        properties = {
          title = "App servers: CPU %", region = data.aws_region.current.region, stat = "Average", period = 300
          metrics = [["AWS/EC2", "CPUUtilization", "AutoScalingGroupName", var.asg_name]]
        }
      },
      {
        type = "metric", x = 8, y = 0, width = 8, height = 6
        properties = {
          title = "App servers: memory used %", region = data.aws_region.current.region, stat = "Average", period = 300
          metrics = [["CWAgent", "mem_used_percent", "AutoScalingGroupName", var.asg_name]]
        }
      },
      {
        type = "metric", x = 16, y = 0, width = 8, height = 6
        properties = {
          title = "App servers: disk used %", region = data.aws_region.current.region, stat = "Maximum", period = 300
          metrics = [["CWAgent", "disk_used_percent", "AutoScalingGroupName", var.asg_name]]
        }
      },
      {
        type = "metric", x = 0, y = 6, width = 8, height = 6
        properties = {
          title = "Load balancer: requests", region = data.aws_region.current.region, stat = "Sum", period = 60
          metrics = [["AWS/ApplicationELB", "RequestCount", "LoadBalancer", var.alb_arn_suffix]]
        }
      },
      {
        type = "metric", x = 8, y = 6, width = 8, height = 6
        properties = {
          title = "Targets: healthy vs unhealthy", region = data.aws_region.current.region, stat = "Maximum", period = 60
          metrics = [
            ["AWS/ApplicationELB", "HealthyHostCount", "TargetGroup", var.target_group_arn_suffix, "LoadBalancer", var.alb_arn_suffix],
            ["AWS/ApplicationELB", "UnHealthyHostCount", "TargetGroup", var.target_group_arn_suffix, "LoadBalancer", var.alb_arn_suffix]
          ]
        }
      },
      {
        type = "metric", x = 16, y = 6, width = 8, height = 6
        properties = {
          title = "Application 5xx errors", region = data.aws_region.current.region, stat = "Sum", period = 300
          metrics = [["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", var.alb_arn_suffix]]
        }
      },
      {
        type = "metric", x = 0, y = 12, width = 8, height = 6
        properties = {
          title = "Database: CPU %", region = data.aws_region.current.region, stat = "Average", period = 300
          metrics = [["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", var.db_instance_id]]
        }
      },
      {
        type = "metric", x = 8, y = 12, width = 8, height = 6
        properties = {
          title = "Database: connections", region = data.aws_region.current.region, stat = "Average", period = 300
          metrics = [["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", var.db_instance_id]]
        }
      },
      {
        type = "metric", x = 16, y = 12, width = 8, height = 6
        properties = {
          title = "Database: free storage (bytes)", region = data.aws_region.current.region, stat = "Minimum", period = 300
          metrics = [["AWS/RDS", "FreeStorageSpace", "DBInstanceIdentifier", var.db_instance_id]]
        }
      }
    ]
  })
}