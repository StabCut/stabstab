### Grsai API：

`POST`

`https://{base_url}/v1/api/generate`

`基础节点：`
`[https://grsaiapi.com](https://grsaiapi.com/) (全球节点)`
`[https://grsai.dakka.com.cn](https://grsai.dakka.com.cn/) (国内节点)`

`例子：`
`https://grsaiapi.com/v1/api/generate`
`https://grsai.dakka.com.cn/v1/api/generate`

## `请求参数`

`Path 参数`

`base_url`

`string` 

`必需`

`Header 参数`

`Authorization`

`string` 

`可选`

`请前往以下页面获取APIKEY：https://grsai.ai/zh/dashboard/api-keys`

`示例:`

`Bearer sk-xxxxxxxxxxx`

`Body 参数application/json必填`

`model`

`string` 

`模型名称`

`必需`

`支持以下模型`
`gpt-image-2`
`gpt-image-2-vip`
`gpt-image-2.5`
`gpt-image-2.5-flare`
`gpt-image-2.5-sunburst`

`prompt`

`string` 

`提示词`

`必需`

`images`

`array[string]`

`参考图`

`可选`

`支持base64与url链接`

`aspectRatio`

`string` 

`比例`

`可选`

`分辨率参数说明`
`gpt-image-2/gpt-image-2.5：支持比例（如 "16:9"）或1K像素值（如 "1024x1024"）`





### New Api：

`curl https://toprouter.sealoshzh.site/v1/images/generations \
  -H "Authorization: Bearer $NEW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
       "model": "gpt-image-2",
       "prompt": "A serene koi pond at sunset, ukiyo-e style.",
       "size": "1024x1024",
       "n": 1
     }'`
`替换 `<YOUR_API_KEY>` 替换为令牌设置中的 API Key。

### 身份验证



所有请求必须携带 `Authorization: Bearer <TOKEN>` 请求头。Anthropic 格式的端点也接受 `x-api-key` 请求头。

在「令牌」页面生成 API Key，可以按模型、分组、IP、速率等维度精细化授权。

### 支持的参数

| 参数              | 类型    | 默认值 / 范围 | 说明信息               |
| :---------------- | :------ | :------------ | :--------------------- |
| `prompt`必填      | string  | —             | 想要生成图像的文字描述 |
| `size`            | enum    | =`1024x1024`  | 输出图像尺寸           |
| `quality`         | enum    | =`standard`   | 生成质量预设           |
| `style`           | enum    | =`vivid`      | 画风                   |
| `n`               | integer | =`1`1 ~ 10    | 生成的图像数量         |
| `response_format` | enum    | =`url`        | 图像结果的返回方式     |

`


