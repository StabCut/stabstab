curl https://api.deepseek.com/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${DEEPSEEK_API_KEY}" \
  -d '{
    "model": "deepseek-flash",
    "input": "用一句话解释 MoE 架构。",
    "instructions": "你是一个乐于助人的助手。",
    "reasoning": {
      "effort": "none"
    },
    "stream": false
  }'