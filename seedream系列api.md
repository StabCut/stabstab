### 官方版本api示例：

`\# Get API Key: https://ark.volcengine.com/region:cn-beijing/apikey`

`curl https://ark.cn-beijing.volces.com/api/v3/responses \`

  `-H "Authorization: Bearer $ARK_API_KEY" \`

  `-H "Content-Type: application/json" \`

  `-d '{`

​      `"model": "doubao-seed-2-1-pro-260628",`

​      `"input": "hello"`

  `}'`

### New  Api 的api示例：

`curl https://toprouter.sealoshzh.site/v1/images/generations \
  -H "Authorization: Bearer $NEW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
       "model": "doubao-seedream-5.0-pro",
       "prompt": "A serene koi pond at sunset, ukiyo-e style.",
       "size": "1024x1024",
       "n": 1
     }'`



