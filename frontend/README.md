# React + TypeScript + Vite + shadcn/ui

This is a template for a new Vite project with React, TypeScript, and shadcn/ui.

## Adding components

To add components to your app, run the following command:

```bash
npx shadcn@latest add button
```

This will place the ui components in the `src/components` directory.

## Using components

To use the components in your app, import them as follows:

```tsx
import { Button } from "@/components/ui/button"
```

---

## 数据快照（不入库）

本目录是 `relay-ledger` 的 React 预览前端，数据来自 `src/data/preview.json`。
该文件含真实经营数据，已加入 `.gitignore`，不随仓库分发。

本地运行前请先生成快照（读取后端各 `/api/*` 接口），放到 `src/data/preview.json`；
缺失时 `npm run build`/`npm run dev` 会在导入处报错，属预期。
