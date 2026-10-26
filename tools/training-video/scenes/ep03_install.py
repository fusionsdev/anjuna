"""Video 3: follow an install and the 4-item checklist (employee view).

Nothing here starts an install: Retry is shown on a past failed install in Deploys.
"""

BRAND = "demo14"  # search text that matches the demo brand's domain
BRAND_DOMAIN = "demo14.aduplift.ai"  # click the domain text; the row centre is the Actions menu button
DETAIL = {"css": ".lifecycle-detail"}

SCENE = {
    "title": "ตอน 3 ติดตามการติดตั้งและรายการตรวจ",
    "steps": [
        {
            "say": "หลังกดสร้างเว็บไซต์ในวิซาร์ด ระบบจะติดตั้งแบรนด์ให้เอง วิดีโอนี้สอนดูว่าติดตั้งถึงขั้นไหน และตรวจสี่ข้อก่อนเปิดโฆษณา",
            "do": [("card", "สอนใช้ Control Panel", "ตอน 3", "ติดตามการติดตั้งและรายการตรวจ 4 ข้อ")],
        },
        {
            "say": "ไปที่เมนู แบรนด์ หน้านี้รวมทุกแบรนด์ ปุ่มด้านบนใช้กรองตามสถานะ เช่น ใช้งาน หยุดชั่วคราว หรือ ติดตั้งล้มเหลว ถ้าหาแบรนด์ไม่เจอ ให้พิมพ์ชื่อโดเมนในช่อง ค้นหาโดเมน",
            "do": [
                ("goto", "/brands"),
                ("point", {"css": ".brand-chips"}),
                ("wait", 2.0),
                ("click", {"css": ".brand-chip", "nth": 3}),
                ("wait", 1.5),
                ("click", {"css": ".brand-chip", "nth": 0}),
                ("wait", 1.0),
                ("type", {"label": "ค้นหาโดเมน (Search domain)"}, BRAND),
            ],
        },
        {
            "say": "คลิกแถวของแบรนด์ แผงรายละเอียดจะเปิดทางขวา ส่วน ความคืบหน้าการติดตั้ง แสดงทุกขั้นของการติดตั้งครั้งล่าสุด ตั้งแต่ตรวจสอบข้อมูล สร้างหน้าเว็บ อัปโหลดไฟล์ ผูกโดเมน ทดสอบหน้าเว็บจริง จนถึงยืนยันผล ขั้นที่เสร็จแล้วขึ้นว่า เสร็จ ขั้นที่กำลังทำขึ้นว่า กำลังทำ",
            "do": [
                ("click", {"within": "table.brand-table", "text": BRAND_DOMAIN, "exact": True}),
                ("wait", 1.5),
                ("scroll", {"within": DETAIL["css"], "text": "ความคืบหน้าการติดตั้ง (Install progress)"}),
                ("point", {"role": "progressbar", "name": "ความคืบหน้าการติดตั้ง (Install progress)"}),
            ],
        },
        {
            "say": "ถ้าการติดตั้งล้มเหลว หน้าประวัติการติดตั้งจะบอกสาเหตุ เช่น โซนของโดเมนยังไม่ active ส่วนในหน้าแบรนด์ ขั้นที่ล้มเหลวจะมีปุ่ม ลองใหม่ กดได้หนึ่งครั้ง ถ้ายังล้มเหลวอีก ให้ส่งชื่อแบรนด์และข้อความสาเหตุให้ Owner อย่ากดซ้ำหลายรอบ",
            "do": [
                ("goto", "/deploys"),
                ("select", {"label": "สถานะ (Status)", "exact": False}, "failed"),
                ("wait", 1.0),
                ("click", {"text": "รายละเอียด (Details)", "nth": 0}),
                ("wait", 1.5),
                ("point", {"css": ".deploy-detail"}),
            ],
        },
        {
            "say": "กลับมาที่แบรนด์ แล้วเลื่อนลงไปที่ รายการตรวจ ซึ่งมีสี่ข้อ สามข้อระบบติ๊กให้เอง Drain route ติ๊กเมื่อ Owner ตั้งบัญชี Google Ads แล้ว LeadsGate postbacks ติ๊กเมื่อระบบใช้ postback token และ Final URL ติ๊กเมื่อทดสอบหน้าเว็บจริงผ่าน ข้อที่ยังไม่ติ๊กจะบอกว่ารออะไรอยู่",
            "do": [
                ("goto", "/brands"),
                ("type", {"label": "ค้นหาโดเมน (Search domain)"}, BRAND),
                ("click", {"within": "table.brand-table", "text": BRAND_DOMAIN, "exact": True}),
                ("scroll", {"within": DETAIL["css"], "text": "รายการตรวจ (Checklist)"}),
                ("point", {"css": ".check-row", "nth": 0}),
                ("wait", 4.0),
                ("point", {"css": ".check-row", "nth": 1}),
                ("wait", 3.5),
                ("point", {"css": ".check-row", "nth": 3}),
            ],
        },
        {
            "say": "ข้อที่ต้องทำเองคือ ยืนยัน Test sold ขอให้ผู้จัดการฝั่ง LeadsGate กด Test sold ให้ลีดทดสอบก่อน เมื่อระบบได้รับผลขาย ช่อง lead_id จะขึ้นมา วางรหัสลีดที่ได้จาก LeadsGate แล้วติ๊กช่องนี้ ระบบจะตรวจกับข้อมูลจริงก่อนบันทึก",
            "do": [("point", {"css": ".check-row", "nth": 2})],
        },
        {
            "say": "เมื่อครบสี่ข้อ กด คัดลอก Final URL แล้วนำไปวางในแคมเปญ Google Ads ท้าย URL ต้องมี keyword เท่ากับ keyword เสมอ กด เปิดเว็บไซต์ เพื่อดูหน้าเว็บจริงอีกครั้ง",
            "do": [
                ("scroll", {"within": DETAIL["css"], "role": "button", "name": "คัดลอก Final URL (Copy Final URL)"}),
                ("click", {"within": DETAIL["css"], "role": "button", "name": "คัดลอก Final URL (Copy Final URL)"}),
                ("wait", 4.0),
                ("point", {"within": DETAIL["css"], "role": "link", "name": "เปิดเว็บไซต์ (Open site)"}),
            ],
        },
        {
            "say": "ดูการติดตั้งย้อนหลังของทุกแบรนด์ได้ที่เมนู ประวัติการติดตั้ง กด รายละเอียด ที่แถวไหนก็ได้ เพื่อดูทุกขั้นของการติดตั้งครั้งนั้น",
            "do": [
                ("click", {"within": "aside.sidebar nav", "text": "ประวัติการติดตั้ง", "exact": True}),
                ("wait", 1.0),
                ("click", {"text": "รายละเอียด (Details)", "nth": 0}),
                ("wait", 1.0),
                ("point", {"css": ".deploy-detail"}),
            ],
        },
        {
            "say": "ตอนต่อไป สอนแก้คีย์เวิร์ด ข้อความหน้าเว็บ และโลโก้ของแบรนด์",
            "do": [("card", "ตอนต่อไป", "แก้ไขแบรนด์", "คีย์เวิร์ด ข้อความ โลโก้ ไทม์ไลน์")],
        },
    ],
}
