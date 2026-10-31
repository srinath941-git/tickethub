[ci]
jenkins ansible_host=${jenkins_public} private_ip=${ips["jenkins"]}

[control_plane]
master ansible_host=${master_public} private_ip=${ips["master"]}

[workers]
worker1 ansible_host=${worker1_public} private_ip=${ips["worker1"]}
worker2 ansible_host=${worker2_public} private_ip=${ips["worker2"]}

[k8s:children]
control_plane
workers

[all:vars]
ansible_user=ubuntu
ansible_ssh_private_key_file=${key_file}
