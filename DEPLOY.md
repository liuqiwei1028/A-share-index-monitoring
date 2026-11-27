# A股指标监测 · 服务器部署说明

一个可以直接上传解压、执行一条命令就跑起来的部署包。
站点是纯静态页面，数据由容器内的定时任务在工作日 16:00 自动更新。

---

## 一、包里有什么

```
etf-monitor/
├── index.html            站点
├── vendor/echarts.min.js 本地图表库（不依赖 CDN）
├── data/                 数据（首次上传时已包含最新一期，部署后立即有内容）
├── scripts/
│   ├── fetch.mjs         收盘数据管道
│   └── intraday.mjs      盘中前瞻（14:30）
├── docker-compose.yml    两个容器：web（nginx）+ updater（node + cron）
├── deploy.sh             一键部署脚本
└── deploy/
    ├── Dockerfile        updater 镜像
    ├── crontab           定时任务
    └── nginx.conf        nginx 配置
```

## 二、服务器要求

| 项 | 要求 |
|---|---|
| 系统 | Ubuntu 20.04+ / Debian 11+ / CentOS 8+（能装 Docker 即可） |
| 配置 | 1 核 1G 足够（站点是静态文件，更新是每分钟级的一次 HTTP 抓取） |
| 磁盘 | 10G 起（数据目录约 15MB，且不随天数增长） |
| 网络 | **必须能访问外网**：新浪、腾讯、东财、中金所、中证指数 |
| 端口 | 默认 8080（可用环境变量改），需在云厂商安全组放行 |

## 三、上传与部署

### 1. 上传与解压

用 scp / WinSCP / 宝塔文件管理，把 `etf-monitor-deploy.tar.gz` 传到服务器，例如 `/root/`。

```bash
cd /root
tar -xzf etf-monitor-deploy.tar.gz   # 解压出 etf-monitor/ 目录
cd etf-monitor
```

### 2. 一键部署

```bash
sudo bash deploy.sh
```

脚本会依次：检查（必要时安装）Docker → 构建镜像 → 启动容器 → 探测站点是否可访问 → 打印地址。

也可以手动分步执行：

```bash
docker compose up -d --build
docker compose ps
```

### 3. 访问

```
http://<服务器公网IP>:8080
```

打不开的九成是**安全组没放行 8080**，去云控制台加一条入站规则即可。

## 三点五、首次部署建议

包里的数据是打包当天的最新一期。如果距离部署日已经超过一周，建议先跑一次**全量回补**，
把中间缺的交易日补齐（约 4 分钟，会重抓 5200 只个股日线）：

```bash
docker compose exec updater node scripts/fetch.mjs
```

之后再交给 16:00 的增量任务即可。
## 四、验证清单

```bash
# 1) 容器都在跑
docker compose ps

# 2) 站点返回 200
curl -I http://127.0.0.1:8080/

# 3) 手动触发一次更新，看是否成功
docker compose exec updater node scripts/fetch.mjs --daily
tail -n 20 data/update.log

# 4) 确认定时任务在容器里
docker compose exec updater crontab -l

# 5) 确认容器时区是上海
docker compose exec updater date
```

第 4 步应看到三行：14:30 盘中前瞻、16:00 收盘更新、21:00 回填。

## 五、自动更新是怎么跑的

容器内 cron（`deploy/crontab`）：

| 时间 | 命令 | 作用 |
|---|---|---|
| 工作日 14:30 | `node scripts/intraday.mjs` | 盘中前瞻，写 `data/intraday.md` |
| 工作日 16:00 | `node scripts/fetch.mjs --daily` | 当日收盘数据，写 `data/indicators.js` |
| 工作日 21:00 | `node scripts/fetch.mjs --daily` | 中证官方 PE 发布后回填，覆盖 16:00 的推算值 |

- **时区**：容器 `TZ=Asia/Shanghai`，cron 按北京时间触发。
- **节假日**：脚本会用沪深300 实时行情的时间戳判断今天是否开市，非交易日直接跳过，不写脏数据。
- **失败重试**：单次抓取失败不会中断其他指标；严重错误写入 `data/cron.err`。

日志位置：

```
data/update.log    收盘管道日志（每次运行追加）
data/intraday.log  盘中前瞻日志
data/cron.err      cron 级别的崩溃信息
```

## 六、日常运维

```bash
# 看实时日志
tail -f data/update.log

# 重启
docker compose restart

# 停止
docker compose down

# 更新代码后重新部署（数据不会丢，data/ 在宿主机）
docker compose up -d --build

# 备份数据
tar czf backup-$(date +%F).tar.gz data/
```

**升级站点**：替换 `index.html`、`vendor/`、`scripts/`，然后 `docker compose restart web`；数据管线改动则要 `docker compose up -d --build updater`。

## 六点五、接入大模型（可选）

报告默认由规则引擎生成，**不依赖任何外部服务**。想让分析更有可读性，可以接一个大模型：
只要服务兼容 OpenAI 的 `/chat/completions` 协议即可。

### 配置

```bash
cd /opt/etf-monitor
cp config/llm.example.json config/llm.json
vi config/llm.json          # 填 baseUrl / apiKey / model
```

`config/llm.json` 已在 `.gitignore` 里，不会被提交。

也可以用环境变量（适合写进 crontab）：

```cron
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat
LLM_API_KEY=sk-xxxx
```

### 常见服务

| 服务 | baseUrl | 参考模型 | 成本 |
|---|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` | 约 1 元 / 百万 token |
| 阿里百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | 有免费额度 |
| 月之暗面 | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` | 按量计费 |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | 有免费档 |
| 本地 Ollama | `http://127.0.0.1:11434/v1` | `qwen2.5:7b` | 自建，需 8G+ 显存/内存 |

**不建议在 1 核 1G 的 VPS 上跑本地模型**——7B 量化模型至少要 8G 内存，推理速度也撑不住。

### 行为

- 每天 16:05 生成报告时，如果配置了 LLM，会额外调用一次（约 2500 token）
- **调用失败不会影响报告**：自动降级为规则引擎的版本，日志里会记录原因
- 页面上的 AI 段带 `AI 分析 · 模型名` 标识，规则引擎的段落仍然保留，两者可对照
## 七、不用 Docker 的部署方式（挂到已有站点子路径）

适用于服务器上已有 Nginx + HTTPS 站点的情况，直接把指标挂到 `https://你的域名/etf/` 下，
不需要新端口、新证书、新 DNS。

### 7.1 装 Node

```bash
node -v            # 已是 v20.11+ 就跳过
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

Node 必须 **20.11 以上**（脚本用了 `import.meta.dirname` 和内置 `fetch`）。

### 7.2 放文件

nginx 的 `root` 会把 URI 原样拼上去，所以目录要能自然映射：

```bash
sudo mkdir -p /var/www/boxtool
sudo tar -xzf etf-monitor-deploy.tar.gz -C /tmp
sudo cp -r /tmp/etf-monitor /var/www/boxtool/etf
sudo chown -R root:root /var/www/boxtool/etf
sudo chmod -R a+rX /var/www/boxtool/etf        # nginx(www-data) 要能读
```

放好之后 `/var/www/boxtool/etf/index.html` 对应 `/etf/index.html`。

### 7.3 加 nginx 配置

把 `deploy/nginx-subpath.conf` 里的四段，插到你现有的 https `server {}` 里、
**`location / { proxy_pass ... }` 之前**。原理是 nginx 取最长前缀匹配，`/etf/` 会优先于 `/`，
不会影响原来的反代站点。

注意两个坑：

1. `location = /etf { return 301 /etf/; }` 不能省，否则直接访问 `/etf`（不带斜杠）时，
   页面里的相对路径会解析成 `/vendor/`、`/data/`，全部 404。
2. nginx 的 `add_header` **不继承**：location 内部一旦写了 add_header，server 级的
   HSTS / X-Content-Type-Options 就失效，所以片段里重复声明了这几个头。

改完检查并重载：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 7.4 配定时任务

```bash
sudo crontab -e
```

粘贴 `deploy/cron-bare.txt` 的内容（`CRON_TZ=Asia/Shanghai` 让时间按北京时间走，
不依赖系统时区）：

```cron
CRON_TZ=Asia/Shanghai
30 14 * * 1-5 cd /var/www/boxtool/etf && /usr/bin/node scripts/intraday.mjs >/dev/null 2>>data/cron.err
0  16 * * 1-5 cd /var/www/boxtool/etf && /usr/bin/node scripts/fetch.mjs --daily >/dev/null 2>>data/cron.err
0  21 * * 1-5 cd /var/www/boxtool/etf && /usr/bin/node scripts/fetch.mjs --daily >/dev/null 2>>data/cron.err
```

确认 cron 服务在跑：`systemctl status cron`。

### 7.5 Cloudflare 缓存

站点在 Cloudflare 后面时，`.js` 属于默认缓存扩展名，`data/indicators.js` 可能被 CF 缓存住，
导致数据不刷新。两边都要处理：

- 源站已发 `Cache-Control: no-store`（片段里写了）
- 再在 CF 控制台加一条 **Cache Rule**：`URI Path starts with /etf/data/` → **Bypass cache**

HTML 默认不缓存，不用管。


## 八、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 页面打不开 | 安全组没放行端口；或 `docker compose logs web` 看 nginx 是否起来 |
| 页面能开但数据不动 | `tail data/update.log` 看最后一次运行；`docker compose exec updater date` 确认时区 |
| 日志里出现「非交易日」 | 正常，节假日自动跳过 |
| 日志里 `fetch failed` | 服务器访问不到新浪/腾讯/东财，检查出网；脚本会对单只失败容错，不会整体中断 |
| cron 报 `ERR_INVALID_ARG_TYPE` 或 `paths[0] must be of type string` | cron 里写的 node 是旧版本（如 /usr/bin/node v18）。用 `which node` 找到 20.11+ 的绝对路径并改 crontab；脚本已兼容 v18+，但仍建议用新版 |
| 定时任务没执行 | `docker compose exec updater crontab -l` 是否有内容；容器是否重启过 |
| 想换端口 | 改 `docker-compose.yml` 的 `WEB_PORT` 环境变量，或 `WEB_PORT=9090 bash deploy.sh` |

## 九、安全提示

站点是纯静态只读页面，没有登录、没有数据库、没有写接口，对外暴露的风险很低。
但如果你要挂到公网域名，建议：

1. 用 Nginx 反代加 HTTPS（certbot 一条命令）；
2. 不要开 22 以外的多余端口；
3. `data/` 目录里只有行情数据，不含任何账号或密钥。
