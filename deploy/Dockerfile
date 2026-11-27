FROM node:22-alpine

# 时区数据：crontab 按 Asia/Shanghai 执行
RUN apk add --no-cache tzdata
ENV TZ=Asia/Shanghai

# 定时任务：工作日 14:30 盘中前瞻、16:00 收盘更新、21:00 官方数据回填
COPY crontab /etc/crontabs/root

WORKDIR /app
CMD ["crond", "-f", "-l", "8"]
