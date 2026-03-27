#!/bin/bash
# l-* スキルを検出してdocker-compose.ymlのボリュームマウントを自動更新する
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/../docker-compose.yml"
SKILLS_DIR="$SCRIPT_DIR/../../.claude/skills"

# l-* スキルディレクトリを検出
LOCAL_SKILLS=()
for d in "$SKILLS_DIR"/l-*/; do
  [ -d "$d" ] && LOCAL_SKILLS+=("$(basename "$d")")
done

if [ ${#LOCAL_SKILLS[@]} -eq 0 ]; then
  echo "ローカル専用スキル（l-*）が見つかりませんでした"
  exit 0
fi

# Pythonでdocker-compose.ymlを安全に更新
python3 -c "
import sys

compose_file = sys.argv[1]
skills = sys.argv[2:]

with open(compose_file, 'r') as f:
    lines = f.readlines()

# 既存のl-*行とコメント行を除去
filtered = []
for line in lines:
    if '# ローカル専用スキル' in line:
        continue
    if '/workspace/.claude/skills/l-' in line:
        continue
    filtered.append(line)

# '# Git設定' の前に挿入
result = []
for line in filtered:
    if '# Git設定' in line:
        result.append('    # ローカル専用スキル（l-*）を空ボリュームで隠す\n')
        for skill in sorted(skills):
            result.append(f'    - /workspace/.claude/skills/{skill}\n')
    result.append(line)

with open(compose_file, 'w') as f:
    f.writelines(result)
" "$COMPOSE_FILE" "${LOCAL_SKILLS[@]}"

echo "docker-compose.yml を更新しました（${#LOCAL_SKILLS[@]}件のl-*スキル）:"
printf "  - %s\n" "${LOCAL_SKILLS[@]}"
