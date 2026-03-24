# SatGPT Git Worktree SOP

## 1. 这套结构到底是什么

当前项目不是两个仓库，而是一个 Git 仓库的多个工作树：

```text
主工作区:
E:\GMS\Flood\SatGPT-app
-> main

Codex 工作树:
C:\Users\Administrator\.codex\worktrees\5ba5\SatGPT-app
-> codex/develop
```

核心认知：

- 主工作区负责稳定开发和最终整合
- worktree 负责并行改功能
- 改完不是“拉回本地”，而是“回主工作区 merge”

## 2. 最常用的命令

### 看所有工作树

```bash
git worktree list
```

### 看主工作区状态

```bash
git -C E:\GMS\Flood\SatGPT-app status -sb
```

### 看某个 Codex 工作树状态

```bash
git -C C:\Users\Administrator\.codex\worktrees\5ba5\SatGPT-app status -sb
```

### 查看本地有哪些分支

```bash
git -C E:\GMS\Flood\SatGPT-app branch -vv
```

如果某个分支前面有 `+`，表示这个分支正在别的 worktree 里被检出。

## 3. 开一个并行分支

从主工作区执行：

```bash
cd E:\GMS\Flood\SatGPT-app
git pull origin main
git worktree add C:\Users\Administrator\.codex\worktrees\feature-a\SatGPT-app -b codex/feature-a main
```

解释：

- `-b codex/feature-a`：新建功能分支
- 最后的 `main`：以主线代码为起点
- 新目录就是新的并行施工位

## 4. 在 worktree 里开发并预览

进入对应 worktree：

```bash
cd C:\Users\Administrator\.codex\worktrees\5ba5\SatGPT-app
```

如果这个 worktree 没有自己的 Python 虚拟环境，直接运行：

```bash
start_worktree.bat
```

这个脚本会：

- 用当前 worktree 的代码启动
- 优先寻找当前目录下的 venv
- 如果找不到，自动回退到主工作区的 `flood-venv` 和 `agent\venv`

如果主工作区不在默认位置，可以先设置：

```bash
set SATGPT_ENV_ROOT=E:\GMS\Flood\SatGPT-app\
start_worktree.bat
```

## 5. 开发完成后提交

在 worktree 中：

```bash
cd C:\Users\Administrator\.codex\worktrees\5ba5\SatGPT-app
git status
git add -A
git commit -m "功能说明"
git push -u origin codex/develop
```

说明：

- 现在 `origin` 已经指向你自己的 `BarberHu/SatGPT-app`
- 所以 `git push origin ...` 不会再误推到团队仓库

## 6. 把 worktree 的改动并回主工作区

回到主工作区：

```bash
cd E:\GMS\Flood\SatGPT-app
git status
git merge codex/develop
```

如果是 fast-forward，说明主工作区直接前进到了功能分支的提交。

然后按需要推送主分支：

```bash
git push origin main
```

## 7. “移动到本地”到底是什么意思

在 Codex 界面里，“移动到本地”更像是：

- 把当前工作焦点切回主工作区
- 或者把这个线程关联到本地目录

它**不等于** Git merge。

请记住这个判断：

```text
移动到本地 = 人回主工地
git merge   = 活并回主楼
```

真正让主工作区获得代码修改的，是：

```bash
git merge 功能分支名
```

## 8. 一个任务结束后的清理

如果功能分支已经合并，不再需要这个 worktree：

```bash
cd E:\GMS\Flood\SatGPT-app
git worktree remove C:\Users\Administrator\.codex\worktrees\5ba5\SatGPT-app
git branch -d codex/develop
```

如果以后还要继续在这个分支上改，就不要删。

## 9. 推荐的固定工作法

建议你以后固定采用下面这套：

1. 主工作区永远保持 `main`
2. 新需求一律新开 `codex/xxx` worktree
3. 在 worktree 里开发、调试、提交
4. 改完回主工作区 `merge`
5. 主工作区确认没问题后再 `push main`

这是 ROI 最高的用法，因为它同时满足：

- 并行开发
- 主线稳定
- 回滚和排错简单
- 不容易把分支和目录搞混
