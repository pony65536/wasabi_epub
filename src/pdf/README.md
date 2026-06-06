# PDF 模块说明

PDF 流程由 Node 负责总编排与翻译，由 Python 负责提取、保留规则判断和回填渲染。

## 分层结构

```text
src/pdf/
  translate_pdf.py        # 稳定 CLI 入口，供 pdfBridge.js 调用
  pdfBridge.js            # Node -> Python 桥接
  pdfHtml.js              # PDF JSON <-> HTML 中间层

  app/
    pdf_cli.py            # CLI 参数解析
    pdf_page_selection.py # --pages 解析

  services/
    pdf_services.py       # Python 用例出口
    pdf_extract_impl.py   # extract 用例编排
    pdf_strip_impl.py     # strip 用例编排
    pdf_fill_impl.py      # fill 用例编排

  domain/
    common.py             # 通用文本 / 几何 / 依赖入口
    layout.py             # 提取、Docling 匹配、layout/block type 判定
    preservation.py       # table/figure/header/footer/peripheral 保留规则
    rendering.py          # 文本回填与样式渲染
    core.py               # 尚未进一步拆散的共享底层实现

  infra/
    vector_extract.py     # 图形层重建等底层 PDF 能力
```

## 依赖方向

- `translate_pdf.py` -> `app/`
- `app/` -> `services/`
- `services/` -> `domain/`
- `domain/` -> `infra/` 或底层库

目标是只让上层依赖下层，不反向引用。

## 当前职责边界

- `app/` 只处理参数与命令分发，不写 PDF 规则。
- `services/` 只编排用例，不承载底层启发式。
- `domain/layout.py` 负责“如何识别块、如何判断 layout/block type”。
- `domain/preservation.py` 负责“哪些区域保留原样”。
- `domain/rendering.py` 负责“如何把翻译文本写回 PDF”。
- `domain/core.py` 只保留暂未进一步拆散的共享底层实现，不应再继续堆用例入口。
- 根目录只保留 `translate_pdf.py` 作为稳定 CLI 入口，其余实现都放在分层子目录内。

## 回归检查

安装 PDF Python 依赖：

```powershell
conda run -n docling python -m pip install -r src/pdf/requirements.txt
```

或在项目根目录直接执行：

```powershell
npm run pdf:install
```

建议每次修改 `src/pdf/` 后至少跑一次轻量回归：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-pdf-regression.ps1
```

这组检查会做：

- Python/Conda 环境定位
- `translate_pdf.py --help` CLI smoke test
- `tests/pdf_regression_check.py` 纯逻辑与导入检查

## 手动验证建议

如果这次改动涉及提取、保留规则或渲染逻辑，除了轻量回归，还建议手动跑一份样本 PDF：

```powershell
conda run -p <docling-prefix> python src/pdf/translate_pdf.py extract input/1706.03762v7.pdf output/pdf_blocks_smoke.json --pages 1
```

建议至少检查：

- `pdf_blocks.json` 能生成
- `doclingSummary` 字段存在
- `blocks[*].blockType / layoutIntent / preserveOriginal` 结构合理
- `fill` 后输出 PDF 可打开

## 后续建议

- 如果继续重构，优先继续压缩 `domain/core.py`
- 优先拆“高频变动且高内聚”的簇，不要按 import 数量拆文件
- 尽量避免再引入只做单行转发的 shim 文件
