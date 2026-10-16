FROM alpine:3.22.2
RUN apk add --no-cache openssh-server bash curl iproute2 darkhttpd && mkdir -p /run/sshd && adduser -D -s /bin/bash developer && adduser -D -s /bin/bash operator
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e", "-f", "/etc/ssh/sshd_config"]
