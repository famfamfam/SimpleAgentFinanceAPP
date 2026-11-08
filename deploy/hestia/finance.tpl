# Dedicated Hestia nginx proxy template. __FINANCE_PORT__ is set on install.
server {
    listen %ip%:%proxy_port%;
    server_name %domain_idn% %alias_idn%;
    root %home%/%user%/web/%domain%/public_html;
    error_log /var/log/nginx/domains/%domain%.error.log error;

    include %home%/%user%/conf/web/%domain%/nginx.forcessl.conf*;
    location ~ /\.(?!well-known\/) { deny all; return 404; }
    location / {
        proxy_pass http://127.0.0.1:__FINANCE_PORT__;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 100s;
        proxy_send_timeout 30s;
        proxy_buffering off;
        proxy_cache off;
        client_max_body_size 12m;
    }
    include %home%/%user%/conf/web/%domain%/nginx.conf_*;
}
