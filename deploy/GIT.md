# 用 git 更新服务器

## 首次：把 /opt/etf-monitor 接入仓库

在服务器上执行（**先备份数据**，虽然 `data/` 已排除、理论上不会被碰）：

```bash
cd /opt/etf-monitor

# 1) 备份，稳妥起见
tar czf /root/etf-data-backup-$(date +%F).tar.gz data/

# 2) 接入仓库
git init
git remote add origin https://github.com/liuqiwei1028/A-share-index-monitoring.git
git fetch origin
git checkout -f -B main origin/main

# 3) 确认数据还在、工作区干净
ls -l data/indicators.js
git status --short        # 应该没有任何输出
```

`git checkout -f` 会用仓库里的版本覆盖 `index.html`、`scripts/`、`deploy/`，
但 `data/` 不在仓库里，原样保留。

## 日常：一条命令更新

```bash
cd /opt/etf-monitor && bash deploy/update.sh
```

脚本内部就是 `git pull --ff-only`，并打印更新前后的 commit。

站点是静态文件，nginx 直接读磁盘，**不需要 reload nginx**；
只有 `deploy/nginx-subpath.conf` 改过时才需要手动同步到 nginx 并 reload。

## 本地开发流程

```bash
cd D:\投资\指标跟踪
git add -A
git commit -m "说明改了什么"
git push
```

然后服务器执行 `bash deploy/update.sh` 即可。

## 一个必须记住的例外

如果改动涉及**新增数据字段**（比如这次加了 `ratio`），光 pull 代码不够——
`data/indicators.js` 里还没有那个字段，页面会显示为空。

拉完代码后补跑一次：

```bash
cd /opt/etf-monitor && node scripts/fetch.mjs --daily
```

纯前端改动（样式、图表、文案）则不需要这一步，刷新浏览器即可。

## 注意

- 仓库是公开的，**不要往里面放任何密钥、token、服务器 IP 密码**。
- `data/` 里只有行情数据，也不含账号信息，但仍然不纳入版本控制。
- 本地 Windows 机器和服务器各自维护自己的 `data/`，两者的数据会分叉。
  建议以服务器为准；如果不想分叉，可以停掉本地 16:00 / 21:00 两个计划任务，
  只保留 14:30 的盘中前瞻（它读的是本地文件）。
