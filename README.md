# COMIC TRANS — Firefox add-on (v2.4.2)

Dịch truyện tranh/webtoon ngay trên trang: gửi ảnh cho Gemini bằng key của bạn, **xoá chữ gốc theo từng nét chữ** rồi vẽ lại bản dịch. Viết lại từ đầu dựa trên các tính năng của userscript 1.6.0, với pipeline mới.

## Thay đổi 2.4.2

- **Đường nối mảnh trong ảnh** (vết nối thẳng 1–3px chạy suốt ảnh, hay gặp ở ảnh truyện tải về): chữ chạm vào đường này (như G, E, D, L, PE… ở cạnh mép bong bóng) từng bị dính vào đường nên không xoá được và bong bóng bị cắt đôi. Giờ add-on vá các đường mảnh dài này trước khi phân tích.
- **Bong bóng viền "lông nhím"**: ranh giới bong bóng được xác định bằng viền đã nở rộng nên khe hở của viền không còn nối hai bong bóng; hai bong bóng nối nhau mà model trả thành một mục sẽ được tách bản dịch theo từng khối chữ. Các nét lông nhím rời sát viền không còn bị xoá nhầm như chữ.
- **Khung lệch/nhỏ/quá to** được thử trên ảnh thật (lệch xuống, lệch lên, nửa trái, nửa phải, một dòng) — chữ gốc xoá sạch và bản dịch vẫn nằm giữa bong bóng.
- **Đã bỏ ô "Cỡ chữ cố định (px)"**; cỡ chữ tự động theo chữ gốc, chỉnh bằng "Hệ số cỡ chữ tự động".

## Thay đổi 2.3.0

- **Tên và liên kết**: COMIC TRANS, https://github.com/ToanCreator/COMIC-TRANS.
- **Không còn gộp dịch chung hai bong bóng**: mỗi bong bóng là một "túi nền" riêng (bị viền ngăn cách). Add-on chỉ xoá/lấy chữ trong túi của mục đang xử lý và không lấy chữ ở túi đã có mục khác đứng tên. Nếu model gộp hai bong bóng riêng thành một mục, bản dịch được chia theo từng bong bóng; nếu model trả hai mục riêng, mỗi mục giữ bản dịch của mình.
- **Số/thanh phụ khác màu không bị xoá nhầm** (ví dụ số "36" trong thanh đậm hơn của bảng hệ thống): chỉ lan sang các nét chữ cùng màu nền cục bộ.
- **Chữ không còn bị che/đè**: vùng đặt chữ dừng ngay khi chạm viền hoặc bất kỳ nét nào chưa xoá.
- **Chữ quá nhỏ**: nhóm nhiễu không còn bị coi là một khối chữ riêng; cỡ chữ lấy theo khối chữ thật.
- **Rà soát bản dịch** (Cài đặt → Ngôn ngữ, bật mặc định): thêm một yêu cầu chữ nhỏ để sửa từ vô nghĩa/sai chính tả/dùng sai từ (ví dụ "cho vai" → "cho vay"). Có thể tắt nếu muốn tiết kiệm lượt gọi API. Prompt dịch cũng yêu cầu chỉ dùng từ có thật, suy luận theo ngữ cảnh khi chữ khó đọc.

## Thay đổi 2.2.0

- **Đổi tên thành COMIC TRANS**; mô tả add-on bằng tiếng Anh. Mã định danh add-on giữ nguyên để không mất cài đặt/API key đã lưu.
- **Chọn ngôn ngữ giao diện** (English, Tiếng Việt, 日本語, 中文) trong Cài đặt → Giao diện; áp dụng cho trang Cài đặt, bảng điều khiển nổi, menu chuột phải và thông báo lỗi. Mặc định theo ngôn ngữ trình duyệt.
- **Nút credit** cuối trang Cài đặt: biểu tượng GitHub bên trái, chữ "ToanCreator", mở https://github.com/ToanCreator/COMIC-TRANS.
- **Vẽ ảnh**: viền bong bóng không còn bị xoá nhầm khi khung của model to hơn bong bóng; bản dịch không đè lên viền, số hay chữ khác trong bảng; bong bóng nối nhau (một mục, hai khối chữ) được tách bản dịch theo từng khối; mục trùng (model trả cùng một chữ hai lần) bị loại; làm sạch vệt mờ quanh chữ gốc.
- **Tiếng Việt không dấu**: prompt yêu cầu đủ dấu; nếu model vẫn trả câu không dấu, add-on gửi một yêu cầu chữ nhỏ để khôi phục dấu (và sửa luôn bản dịch đang nằm trong bộ nhớ đệm).
- **Bảng thuật ngữ**: là danh sách thay thế theo nghĩa đen `gốc = dịch`. Quy tắc xưng hô giữa nhân vật (ví dụ Loy gọi Baron là "cha") ghi vào ô "Ghi chú cho người dịch", không ghi vào bảng thuật ngữ.

## Thay đổi 2.1.1

- **Sửa lỗi vẽ ảnh**: khung chữ Gemini trả về hay *nhỏ hơn chữ thật* hoặc *lệch xuống* nên chữ gốc bị xoá sót một nửa (còn "…SS IT'S A", dấu "?"), hoặc không xoá mà vẽ bản dịch đè bên dưới. Giờ add-on chỉ dùng khung làm "hạt giống", rồi tự lan theo các nét chữ sát nhau trong cùng bong bóng để xoá **toàn bộ** chữ gốc và đo lại vùng chữ thật (cỡ chữ, chỗ đặt bản dịch dựa trên vùng này).
- Cửa sổ xử lý quanh mỗi khung rộng hơn; viền khử răng cưa của chữ to được xoá dày hơn (tránh bóng mờ).
- Nếu model tách một bong bóng thành 2 mục, bản dịch được **gộp và vẽ một lần** (không còn hai bản dịch chồng lên nhau).
- Prompt yêu cầu khung bao đủ ký tự đầu/cuối của mọi dòng (chọn rộng hơn thay vì hẹp hơn).
- Ô dán API key: gợi ý đổi từ `AIza...` thành `AQ.Ab8RN6...` (key định dạng mới; add-on không giới hạn tiền tố key).

## Cài đặt

**Dùng thử (mọi bản Firefox):**
1. Mở `about:debugging#/runtime/this-firefox`
2. Bấm **Load Temporary Add-on…** và chọn `manifest.json` trong thư mục đã giải nén (hoặc chọn file `.zip`).
3. Tab Cài đặt tự mở. Dán key Gemini, bấm **Kiểm tra key**, rồi (tuỳ chọn) **Tải danh sách model từ key**.

Add-on tạm thời sẽ mất khi tắt Firefox. Muốn cài vĩnh viễn: ký qua AMO (kênh *unlisted*, `web-ext sign`), hoặc dùng Firefox Developer Edition/Nightly với `xpinstall.signatures.required = false`. Khi đưa lên AMO cần khai thêm `data_collection_permissions` trong manifest (add-on gửi ảnh trang tới Google Gemini).

## Cách dùng (thiết kế cho điện thoại, máy tính vẫn dùng được)

Trên trang có nhiều ảnh lớn, một **nút nổi tròn** tự hiện ở góc phải dưới (kéo để dời chỗ). Nếu không thấy, mở menu Firefox → Tiện ích → Auto Comic Translate.
Chạm nút nổi để mở bảng điều khiển; khi đang dịch bảng tự thu lại, nút nổi hiện tiến độ `7/19` và chấm đỏ nếu có lỗi.

- **Dịch cả trang**: ảnh đang xem được dịch trước, các ảnh khác chạy song song.
- **Ảnh đang xem**: chỉ dịch ảnh đang ở giữa màn hình.
- **Từ đây trở xuống**: dịch ảnh đang xem và mọi ảnh phía sau (hợp đọc webtoon).
- **Chạm để chọn ảnh**: chạm vào ảnh nào thì dịch ảnh đó (không bị nhảy sang trang liên kết).
- **Khoanh vùng**: kéo ngón tay quanh vùng có chữ; vùng được phóng to để đọc chữ nhỏ rồi gộp vào kết quả cũ.
- **Tự dịch khi cuộn tới**: ảnh sắp cuộn tới được dịch trước.
- **Xem gốc / Xuất PDF**.
- Máy tính: `Alt+Shift+T` hiện/ẩn bảng, `Alt+Shift+Y` dịch cả trang, chuột phải lên ảnh → *Dịch ảnh này* (Firefox Android không có hai tính năng này).

## Khác gì so với userscript

| | Userscript 1.6 | Bản này |
|---|---|---|
| Việc của Gemini | OCR + toạ độ + dịch + màu + tóm tắt + glossary, 9 trường mỗi khung | Chỉ toạ độ + bản dịch + loại khung (3 trường), schema ngắn |
| Song song | 3 yêu cầu toàn cục, mỗi yêu cầu 3 lát ảnh | Giới hạn **riêng từng key**, 1 lát/yêu cầu, tự giảm khi 429 và tự tăng lại |
| Cắt ảnh dài | Cắt theo chiều cao cố định | Cắt tại **hàng trống** giữa panel, không cắt ngang chữ |
| Xoá chữ trong bong bóng | Heuristic + tô hình chữ nhật | Flood-fill nền, chỉ xoá các "đảo" chữ nằm trong ruột bong bóng, viền bong bóng giữ nguyên |
| Xoá chữ ngoài bong bóng | Nội suy 4 cạnh hình chữ nhật (nhoè) | Tách riêng nét chữ (top-hat/black-hat) rồi điền lại + thêm hạt nhiễu cho khớp tranh |
| Không chắc chắn | Vẫn tô | **Không đụng vào ảnh** nếu không tìm thấy chữ |
| Xử lý ảnh | Luồng chính của trang | Web Worker (song song theo số nhân CPU), trang không bị đơ |
| Cache | Không | Lưu vùng chữ từng ảnh; đổi phông/cỡ chữ là vẽ lại ngay, không gọi API |

## Lỗi thường gặp

- **`Gemini 400: Request contains an invalid argument`**: model không nhận một tuỳ chọn trong yêu cầu. Từ 2.1, add-on tự dò (tắt thinking → bỏ safety → bỏ schema) bằng một ảnh nhỏ trước khi dịch và chỉ báo lỗi khi model từ chối mọi cấu hình. Vào Cài đặt → **Kiểm tra đầy đủ** để xem cấu hình được chọn. Nếu vẫn lỗi, kiểm tra tên model bằng **Tải danh sách model từ key**.
- **Các key đều "chờ 46s" (429)**: nhiều key tạo trong cùng một project dùng chung hạn mức. Add-on nhận ra điều này và chạy chậm lại; hãy tạo key ở các project khác nhau, hoặc giảm "yêu cầu song song mỗi key".
- **`quota = 0 với model này`**: key chưa được cấp quota cho model đó (thường gặp với model không có bậc miễn phí). Đổi model.
- Đừng chụp màn hình có lộ header `x-goog-api-key`; nếu lỡ lộ, hãy thu hồi và tạo key mới.

## Đã kiểm thử gì, chưa kiểm thử gì

Đã chạy (thư mục `tests/`):
- Thuật toán lõi trên trang truyện giả lập: bong bóng trắng, tối, khung phẳng, chữ viền trên tranh sọc, chữ đen trên nền nhạt, hai bong bóng sát nhau, bong bóng chuyển màu. Tất cả xoá sạch chữ gốc.
- Worker thật, content script thật và luồng background→worker thật trong **Chromium** (Playwright), với Gemini được giả bằng phản hồi định sẵn: vẽ chữ, cắt webtoon vào đúng khe trắng, vùng chọn, PDF (mở được bằng pdf-lib), CSP chặn blob, tự dịch.
- 21 test đơn vị + 15 test luồng (model từ chối thinking/safety/mọi cấu hình, quota 0, 429, JSON bị cắt, key sai, cache, 404; chạy cả khi thiếu `webRequest`/`commands`/`contextMenus` như Firefox Android).
- 33 test giao diện trong Chromium giả lập điện thoại 390×844 với **cảm ứng thật** (chạm, kéo nút nổi, khoanh vùng bằng ngón tay, nút ≥ 44px, không tràn màn hình).

**Chưa** kiểm thử: trên Firefox (cả máy tính lẫn Android) thật; với Gemini API thật; trên các trang đọc truyện thật; so tốc độ với comictranslator.com. Con số tốc độ phụ thuộc gói/hạn mức key và độ trễ của model, bảng điều khiển hiển thị thời gian, token và trạng thái từng key để bạn tự đo.

## Giới hạn đã biết

- Chữ trực tiếp trên tranh nhiều chi tiết: nét chữ được xoá sạch nhưng chỗ điền lại hơi mờ (không có mô hình inpainting thần kinh). Tắt mục "Chữ nằm trực tiếp trên tranh" nếu không ưng.
- Chưa xử lý riêng chữ xoay nghiêng/cong, chữ dính sát viền bong bóng; chữ dọc chỉ ước lượng cỡ.
- Chỉ dùng phông cài trong máy; cần phông có dấu tiếng Việt (Noto Sans, Arial… đều ổn).
- Ảnh nằm trong iframe chưa được hỗ trợ.
- Model mặc định `gemini-3.5-flash-lite` giữ giống script cũ của bạn; nếu báo lỗi 404, dùng **Tải danh sách model từ key**.
- Với key miễn phí, Google có thể dùng dữ liệu gửi lên theo điều khoản hiện hành của Gemini API. Hãy tự kiểm tra điều khoản.

## Gỡ lỗi

`about:debugging` → *This Firefox* → add-on → **Inspect** để xem console của background (lỗi API, 429…). Console của trang (F12) hiện lỗi của content script.

## Chạy test

```
cd tests
python3 make_synth.py && python3 make_tall.py && python3 make_widths.py
python3 make_misbox.py && node test_misbox.js && node test_merge.js && python3 make_cases2.py && node test_cases2.js && python3 make_cases3.py && node test_cases3.js && python3 make_fuzzy.py && NOTEXT=1 python3 make_fuzzy.py && node test_fuzzy.js   # khung model nhỏ/lệch/quá to + gộp bong bóng bị tách
node test_units.js && node test_flow.js && node run_core.js   # run_core cần synth.json/widths.json ở trên
node browser_worker_test.js && node browser_content_test.js && node browser_e2e_test.js   # cần playwright + chromium
```

## Hướng phát triển tiếp

1. Inpainting thần kinh (LaMa dạng ONNX qua `onnxruntime-web`/WebGPU) cho chữ trên tranh, cắm vào `fillHoles` mà không đổi phần còn lại.
2. Chế độ máy chủ riêng (detector + OCR + LaMa trên GPU), Gemini chỉ dịch văn bản.
3. Streaming phản hồi để bắt đầu vẽ trước khi model trả xong.
4. Bản Chrome (Manifest V3, offscreen document).
