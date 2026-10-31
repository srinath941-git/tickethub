output "jenkins_url" {
  value = "http://${aws_eip.jenkins.public_ip}:8080"
}

output "ingress_ip" {
  description = "Point the tickets and grafana DNS A records at this address"
  value       = aws_eip.ingress.public_ip
}

output "master_public_ip" {
  value = aws_instance.node["master"].public_ip
}

output "private_ips" {
  value = { for k, v in aws_instance.node : k => v.private_ip }
}
