# Notion Custom Domain

为你的 Notion 页面绑定自定义域名。发布页面后,可以使用自己的域名访问,而不是 `notion.site`。

[![Notion Custom Domain](https://user-images.githubusercontent.com/19500280/93695277-d99aa400-fb4f-11ea-8e82-5c431110ce19.png)](https://notion-custom-domain.hosso.co)

## 快速开始

安装依赖:

```
yarn
```

指定要代理的 Notion 公开页面,然后部署到 Vercel:

```
PAGE_URL=https://<your-domain>.notion.site/<Your-Page-ID> \
yarn deploy:prod
```

例如:

```
PAGE_URL=https://notion.notion.site/Notion-Official-83715d7703ee4b8699b5e659a4712dd8 \
yarn deploy:prod
```

最后,在 Vercel Dashboard 上为该部署配置自定义域名。参见 [Custom Domains – Vercel Docs](https://vercel.com/docs/concepts/projects/custom-domains)。

![](https://user-images.githubusercontent.com/19500280/169642461-c31df143-a8a5-4d37-8494-e5b04b01c7b1.png)

## 本地开发

### 本地运行

```
PAGE_URL=https://<your-domain>.notion.site/<Your-Page-ID> \
yarn dev
```

然后打开 http://localhost:3000。

### 使用 Node Inspector 调试

```
PAGE_URL=https://<your-domain>.notion.site/<Your-Page-ID> \
yarn debug
```

然后打开 http://localhost:3000。

## SEO、Slug 与统计分析设置

所有可调整的配置项都集中在同一个文件中:[`src/config.ts`](src/config.ts)。除了 Notion Token 这类敏感信息需要通过环境变量设置外,其余配置都可以直接在该文件中修改,无需改动其它代码。

### 1. 配置 Notion 集成 Token

页面内的属性(标题 / Description / Slug)需要通过 Notion 官方 API 读取,因此需要创建一个 [Notion 集成](https://www.notion.so/my-integrations) 并将其 Token 设置为环境变量(注意这是密钥,不要写进代码里):

```
NOTION_API_TOKEN=secret_xxx
```

创建集成后,别忘了在 Notion 页面中把该集成添加为「连接」,否则 API 无权限读取数据。

### 2. 在 `src/config.ts` 中配置数据库与属性名

一个 Notion 页面内可能包含多个数据库,把每个数据库的 ID 都填入 `notion.databaseIds`:

```ts
notion: {
  databaseIds: [
    '填入数据库 ID 1',
    '填入数据库 ID 2',
  ],
  propertyNames: {
    title: 'Name',        // 标题属性名
    description: 'Description', // 描述属性名
    slug: 'Slug',          // Slug 属性名
  },
},
```

规则如下:

- 若某条记录存在 **Description** 属性,则使用它作为该页面的 SEO 描述(`meta description` / `og:description` / `twitter:description`)。
- 若某条记录存在 **Slug** 属性,则使用它作为访问该页面的 URL 路径;若没有 Slug 属性,则回退使用原有的页面标题字符串作为 slug。
- 标题属性会作为该页面的 `<title>` 与 `og:title` / `twitter:title`。

### 3. 站点默认 SEO、验证与统计分析

同样在 `src/config.ts` 中配置:

```ts
seo: {
  defaultTitle: '',       // 根页面默认标题,留空则使用 Notion 原始标题
  defaultDescription: '', // 根页面默认描述
  siteName: '',           // 站点名称(用于 og:site_name)
},

verification: {
  google: '',  // Google Search Console 验证码
  bing: '',    // Bing Webmaster 验证码
},

analytics: {
  googleAnalyticsId: process.env.GA_MEASUREMENT_ID ?? '', // GA4 衡量 ID,例如 G-XXXXXXXXXX
  vercelAnalytics: true,       // 是否启用 Vercel Analytics
  vercelSpeedInsights: true,   // 是否启用 Vercel Speed Insights
},
```

### 4. 缓存刷新间隔

SEO 与 Slug 数据会被拉取到内存中缓存,并按设定的间隔自动刷新,默认每 **1 小时** 刷新一次,无需重新部署:

```ts
// 1 小时 = 60 * 60 * 1000 毫秒
refreshIntervalMs: 60 * 60 * 1000,
```

按需调整该数值即可改变刷新频率。

> 注意:`vercel.json` 中包含一条将 8 个字符以内的短路径重定向到首页的规则(`/[^/.]{1,8}` → `/`)。如果你的自定义 slug 短于 9 个字符(例如 `/faq`),会被该规则拦截 —— 如需支持短 slug,请删除这条重定向配置。

## Google Analytics 支持(旧版单独配置方式)

除了在 `src/config.ts` 中配置 `analytics.googleAnalyticsId` 外,也可以在部署时通过环境变量 `GA_MEASUREMENT_ID` 直接注入统计代码:

```
PAGE_URL=https://<your-domain>.notion.site/<Your-Page-ID> \
GA_MEASUREMENT_ID=G-XXXXXXXXXX \
yarn deploy:prod
```

## 在 Vercel Dashboard 中使用环境变量

你也可以直接在 Vercel Dashboard 上设置环境变量。这样就可以直接运行
`vercel env pull`、`vercel dev`、`vercel deploy` 或 `vercel deploy --prod`,而无需在命令行手动传入环境变量。

![](https://github.com/hosso/notion-custom-domain/assets/19500280/e234a2eb-8ba7-4be0-a1dd-fa58ce0327ab)

## 生产环境监控

仓库中内置了一个定时 GitHub Actions 工作流,位于 `.github/workflows/monitor.yml`。
它每 6 小时自动运行一次,也可以在 Actions 页面手动触发。

请将仓库变量 `SITE_URL` 设置为你要监控的自定义域名地址,例如:

```text
https://notion-custom-domain.hosso.co
```

该监控会检查目标站点是否:

- 返回 HTTP 成功状态码
- 返回 HTML 内容
- 已注入自定义的 location 代理脚本
- 已注入自定义样式覆盖

当检查失败时,工作流会:

- 上传 HTML、响应头及 JSON 摘要作为构建产物(artifacts)
- 创建或更新一个标题为 `Monitoring alert: production smoke test failed` 的 GitHub issue

详细的排查步骤见 [`docs/monitoring.md`](docs/monitoring.md)。

你也可以在本地运行相同的检查:

```sh
SITE_URL=https://notion-custom-domain.hosso.co yarn monitor:smoke
```

## 许可证

[MIT](LICENSE)
