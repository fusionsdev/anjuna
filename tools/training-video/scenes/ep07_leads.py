"""Video 7: leads, conversions, mailing list, audit log (employee view). Employees never see applicant data."""

FILTERS = "section[aria-label='ตัวกรองลีด (Lead filters)']"
LIST = "section[aria-label='รายการลีด (Lead list)']"

SCENE = {
    "title": "ตอน 7 ลีดและคอนเวอร์ชัน",
    "steps": [
        {
            "say": "วิดีโอสุดท้ายสอนดูลีด คอนเวอร์ชัน รายชื่ออีเมล และประวัติการแก้ไข",
            "do": [("card", "สอนใช้ Control Panel", "ตอน 7", "ลีด คอนเวอร์ชัน และประวัติ")],
        },
        {
            "say": "หน้า ลีด รวมลีดทุกรายการ กรองตามแบรนด์ ช่วงวันที่ และสถานะ เช่น ขายได้ รอผล หรือถูกปฏิเสธ ถ้ามีรหัสลีด พิมพ์สี่ตัวแรกในช่อง ค้นหา",
            "do": [
                ("goto", "/leads"),
                ("point", {"css": FILTERS}),
                ("wait", 3.0),
                ("select", {"within": FILTERS, "label": "สถานะ (Status)", "exact": False}, {"label": "รอผล (Pending)"}),
                ("wait", 1.5),
            ],
        },
        {
            "say": "คอลัมน์ ตรวจยอด บอกว่าลีดนั้นได้ผลจาก LeadsGate แล้วหรือยัง และส่งคอนเวอร์ชันขึ้น Google Ads แล้วหรือยัง ถ้าขึ้นว่า ขายแล้วแต่ไม่มีรายการอัปโหลด ให้แจ้ง Owner",
            "do": [
                ("point", {"css": f"{LIST} td[data-label='ตรวจยอด (Reconciliation)']", "nth": 0}),
                ("wait", 2.0),
            ],
        },
        {
            "say": "คลิกรหัสลีดเพื่อเปิดรายละเอียด ข้อมูลส่วนตัวของผู้สมัครเห็นได้เฉพาะ Owner ส่วน Postback Inspector แสดงทุกผลที่ LeadsGate ส่งกลับมา และสถานะการส่งคอนเวอร์ชัน",
            "do": [
                ("click", {"css": f"{LIST} td[data-label='รหัสลีด (Lead ID)'] a", "nth": 0}),
                ("wait", 1.5),
                ("point", {"text": "ผู้สมัคร (Applicant)", "exact": True}),
                ("wait", 3.0),
                ("scroll", {"text": "Postback Inspector", "exact": True}),
                ("point", {"text": "Postback Inspector", "exact": True}),
            ],
        },
        {
            "say": "หน้า คอนเวอร์ชัน แสดงลีดที่ขายได้และผลการส่งขึ้น Google Ads ช่องด้านบนนับ ค้างส่ง กำลังส่ง ส่งแล้ว และส่งไม่ได้ คอลัมน์ เหตุผล บอกสาเหตุและวิธีแก้ของรายการที่ส่งไม่ได้",
            "do": [
                ("goto", "/conversions"),
                ("point", {"css": "[aria-label='สรุปคอนเวอร์ชัน']"}),
                ("wait", 4.0),
                ("click", {"within": "[aria-label='สถานะ']", "role": "button", "name": "ส่งไม่ได้", "exact": False}),
                ("wait", 1.5),
            ],
        },
        {
            "say": "หน้า รายชื่ออีเมล แสดงลีดที่ยินยอมรับข่าวสาร และสถานะการส่งเข้า listmonk หน้านี้ดูอย่างเดียว",
            "do": [
                ("goto", "/mailing"),
                ("point", {"css": "main h1"}),
                ("wait", 2.0),
                ("point", {"text": "การเชื่อมต่อ listmonk", "exact": True}),
            ],
        },
        {
            "say": "หน้า ประวัติการแก้ไข บันทึกว่าใครแก้อะไร เมื่อไหร่ บัญชีพนักงานเห็นเฉพาะรายการของตัวเอง ใช้ตรวจย้อนหลังเมื่อค่าของแบรนด์เปลี่ยนโดยไม่คาดคิด",
            "do": [
                ("goto", "/audit"),
                ("point", {"css": "main h1"}),
                ("wait", 3.0),
                ("point", {"css": "main table"}),
            ],
        },
        {
            "say": "จบชุดวิดีโอสอนใช้ Control Panel ถ้าเจอปัญหาที่ไม่มีในวิดีโอ ให้ถาม Owner ค่ะ",
            "do": [("card", "จบชุดวิดีโอ", "สอนใช้ Control Panel", "มีคำถาม ถาม Owner")],
        },
    ],
}
