# 📌 Reference Overlay 阶段锁定（V1.7）

## 一、阶段结论

Reference Overlay 已完成：

配置  
→ 自动同步  
→ 状态保护  
→ API  
→ SpotChart  
→ 后台运营

完整闭环。

达到：

可配置  
可扩展  
可同步  
可运营

状态。

---

## 二、支持标的

### MFCUSDT

`reference_type=IRON`

状态：

`AUTO`  
`SUCCESS`

数据来源：

`IRON62`

已真实验收。

---

### IGCUSDT

`reference_type=GOLD`

状态：

`AUTO`  
`SUCCESS`

数据来源：

`iTick XAUUSD`

已真实 HTTP 验收。

---

### BON-2USDT

`reference_type=STOCK`

状态：

`MANUAL`

未开发自动同步。

---

### CREG-2USDT

`reference_type=STOCK`

状态：

`MANUAL`

未开发自动同步。

---

### IMAA-2USDT

`reference_type=STOCK`

状态：

`MANUAL`

未开发自动同步。

---

## 三、数据库结构

`reference_overlays`

重要字段：

- `price_source`
- `auto_source`
- `sync_status`
- `market_status`
- `is_realtime`
- `price_time`
- `last_sync_at`
- `sync_error`

---

## 四、同步状态机

- `PENDING`
- `SUCCESS`
- `FAILED`

说明：

`SUCCESS` 才允许 API `enabled=true`。

`FAILED` 自动保护。

---

## 五、API

`GET /market/reference-overlays`

返回：

- `enabled`
- `display_price`
- `display_value_label`
- `market_status`
- `price_time`

---

## 六、后台

`/admin/reference-overlays`

能力：

- 新增
- 编辑
- 启用
- 禁用
- 同步

状态中文化。

---

## 七、SpotChart

完全配置驱动：

不再写死：

- `MFCUSDT`
- `IRON`
- `GOLD`

前端零业务感知。

---

## 八、关键验收

MFCUSDT：

`SUCCESS`

IGCUSDT：

`SUCCESS`

`price_time`：

已修复 `1970-01-01` 问题。

---

## 九、后续规划（非当前范围）

STOCK 自动同步：

- `BON-2USDT`
- `CREG-2USDT`
- `IMAA-2USDT`

后续单独立项。

---

## 最终结论

Reference Overlay 模块 V1 完整收口，进入维护状态。
