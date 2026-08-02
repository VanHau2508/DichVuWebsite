-- 0130 — Bịt DELETE trên dòng hoa hồng CTV.
--
-- 0129 chỉ GRANT SELECT/INSERT/UPDATE, nhưng app_rw VẪN có DELETE: vai được cấp quyền
-- theo lô ở bước provision role, nên bảng mới thừa hưởng. Cùng lý do cod_remittances
-- (0079) và refunds phải REVOKE tường minh — GRANT hẹp KHÔNG tự thu hồi cái đã có.
--
-- Vì sao cấm: xoá được dòng hoa hồng là xoá được NGHĨA VỤ đã phát sinh với CTV — CTV
-- không còn gì để đối chiếu. Muốn huỷ hoa hồng thì chuyển status='void' (có void_reason,
-- có vết); muốn sửa số tiền thì đó là dòng mới, không phải xoá dòng cũ.
--
-- KHÔNG revoke UPDATE: khác cod_remittances/refunds, bảng này CÓ vòng đời trạng thái
-- (pending → eligible → paid), sweep phải cập nhật được.
REVOKE DELETE ON affiliate_commissions FROM app_rw;

-- Cấu hình chương trình: xoá cả dòng cấu hình rồi tạo lại là cách né mọi vết sửa mức hoa
-- hồng. Chỉ cho INSERT (lần đầu) + UPDATE.
REVOKE DELETE ON shop_affiliate_config FROM app_rw;
