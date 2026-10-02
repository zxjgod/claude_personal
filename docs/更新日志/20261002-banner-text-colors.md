# 启动横幅文字配色对齐参考图

- 日期：2026-10-02
- 提交主题：`style: match startup banner text colors to the reference`

品牌名使用橙色，欢迎语使用明亮白色，右侧说明使用 `#CCCCCC`，版本、模型、provider 与工作区路径使用 `#999999`；`/release-notes for more` 使用灰色斜体。颜色通过横幅专用 palette 字段定义，取代终端 `dim` 与 cyan；深浅主题切换同步这些字段，并补齐询问面板 accent 的主题更新。

验证：24 个相关测试、类型检查、Biome 定向检查及构建通过；真实 banner ANSI 输出已核对深浅主题颜色，并生成渲染预览。文字配色改动不依赖模型调用。
