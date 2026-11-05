output "public_ip" {
  description = "Point raadio.run.place (DNSExit) at this address"
  value       = aws_eip.radio.public_ip
}

output "instance_id" {
  value = aws_instance.radio.id
}

output "ssh" {
  value = "ssh ubuntu@${aws_eip.radio.public_ip}"
}

output "disk_gb" {
  value = var.root_volume_size
}
