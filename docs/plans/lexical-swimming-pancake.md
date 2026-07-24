# Update CHANGELOG.md — YAML syntax highlighting + highlighted edit overlay

## Context
Trong session này đã thêm 3 phần liên quan đến YAML view/edit trong K8s Manage:
1. Syntax highlighting (key/string/number/bool/comment/dash/doc-separator) cho YAML tab, Full Manifest Diff (dòng "same"), và History diff (dòng "same").
2. Line-number gutter + indentation guides, dùng chung layout cho cả View và Edit.
3. Chuyển Edit mode từ `<textarea>` thuần sang overlay trong suốt nằm trên `<pre>` đã tô màu (để Edit nhìn giống hệt View), kèm Tab/Shift+Tab chèn/bớt 2 space.
4. Fix lỗi caret lệch theo độ sâu indent (nguyên nhân: `.yaml-indent-guide` dùng `border-left` làm tăng layout width trong `<pre>` mà `<textarea>` không có — đổi sang `background-image` gradient, không ảnh hưởng layout).

Đây là task viết tài liệu đơn thuần — chỉ cần thêm 1 entry mới vào đầu mục `### Added` (hoặc mục riêng) trong `## Unreleased` của `CHANGELOG.md`, theo đúng văn phong/độ chi tiết đã có (mỗi phase là 1 bullet lớn, có bullet con nêu file/hàm liên quan). Không cần Explore/Plan agent — task quá nhỏ và rõ ràng.

## Approach
Thêm 1 bullet mới vào `### Added` trong `## Unreleased` (`CHANGELOG.md`, ngay dưới dòng `### Added` ở line 8, phía trên bullet "K8s Manage (Phase 17)"), viết bằng tiếng Anh để nhất quán với toàn bộ file:

```markdown
- **K8s Manage — YAML syntax highlighting & highlighted edit overlay**: the drawer's YAML tab (plus unchanged lines in Full Manifest Diff and History diff) now render with color-coded tokens (keys, strings, numbers, booleans/null, comments, list dashes, `---`/`...` separators), a dimmed line-number gutter, and faint per-level indentation guides.
  - `renderer/app.js`: new regex-based line tokenizer (`highlightYaml`/`highlightYamlLine`/`tokenizeYamlScalar`/`findYamlCommentStart`) reused by `loadManageYaml()`, `renderManifestDiff()`, and `showHistoryDiff()` — diff added/removed lines intentionally stay plain-colored so the red/green diff signal isn't overridden by token colors.
  - Edit mode now overlays a transparent `<textarea>` on top of the same highlighted `<pre>` (instead of a plain unstyled textarea), so View and Edit look identical; the `<pre>` re-highlights live on every keystroke. Tab/Shift+Tab insert or remove 2-space indents (including across multi-line selections) since YAML uses spaces, not tabs.
  - Indentation guides are painted via a `background-image` gradient rather than `border-left` — a border would add layout width inside the `<pre>` that the borderless overlay `<textarea>` lacks, drifting the caret away from its glyph on deeply-nested lines (e.g. clicking after `port: 80` would land the caret mid-digit).
```

## Verification
- Đọc lại `CHANGELOG.md` sau khi sửa để đảm bảo markdown hợp lệ và thứ tự bullet không bị xáo trộn các phase cũ.
- Không cần chạy app (thay đổi chỉ là tài liệu).
