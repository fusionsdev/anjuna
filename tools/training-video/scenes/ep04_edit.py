"""Video 4: edit a live brand: runtime config drawer, duplicate, timeline (employee view).

Points at Save buttons and never clicks them. Duplicate opens its dialog only, then Cancel.
"""

BRAND = "demo14"
BRAND_DOMAIN = "demo14.aduplift.ai"
DETAIL = ".lifecycle-detail"
DRAWER = ".config-drawer"

SCENE = {
    "title": "ตอน 4 แก้ไขแบรนด์",
    "steps": [
        {
            "say": "วิดีโอนี้สอนแก้แบรนด์ที่ใช้งานอยู่ ได้แก่ คีย์เวิร์ด ข้อความหน้าเว็บ โลโก้ การทำสำเนาแบรนด์ และไทม์ไลน์",
            "do": [("card", "สอนใช้ Control Panel", "ตอน 4", "แก้ไขแบรนด์")],
        },
        {
            "say": "เปิดเมนู แบรนด์ ค้นหาโดเมน แล้วคลิกชื่อแบรนด์ ในแผงรายละเอียด เลื่อนลงไปที่ การตั้งค่า runtime แล้วกด ตั้งค่าแบรนด์",
            "do": [
                ("goto", "/brands"),
                ("type", {"label": "ค้นหาโดเมน (Search domain)"}, BRAND),
                ("click", {"within": "table.brand-table", "text": BRAND_DOMAIN, "exact": True}),
                ("scroll", {"role": "button", "name": "ตั้งค่าแบรนด์ (Runtime config)"}),
                ("click", {"role": "button", "name": "ตั้งค่าแบรนด์ (Runtime config)"}),
                ("wait", 1.0),
            ],
        },
        {
            "say": "แผงตั้งค่าแบรนด์จะเปิดทางขวา ช่อง คีย์เวิร์ดเริ่มต้น ใช้เมื่อลิงก์โฆษณาไม่ได้ส่งคีย์เวิร์ดมา ถ้าเว้นว่าง จะใช้ข้อความของเทมเพลต แก้แล้วกด บันทึก ข้างช่องนั้น",
            "do": [
                ("point", {"within": DRAWER, "text": "คีย์เวิร์ดเริ่มต้น (Keyword default)"}),
                ("wait", 4.0),
                ("point", {"within": DRAWER, "role": "button", "name": "บันทึก (Save)", "nth": 0}),
            ],
        },
        {
            "say": "ส่วน ข้อความหน้าเว็บ แก้ชื่อแบรนด์บนเว็บ ชื่อหน้า และคำอธิบายได้ ป้ายข้างช่องบอกว่าค่ามาจากไหน กด รีเซ็ต เพื่อกลับไปใช้ค่าของเทมเพลต กล่องตัวอย่างแสดงผลที่จะขึ้นบน Google แล้วกด บันทึกข้อความหน้าเว็บ",
            "do": [
                ("scroll", {"within": DRAWER, "text": "ข้อความหน้าเว็บ (Site text)"}),
                ("point", {"within": DRAWER, "text": "ข้อความหน้าเว็บ (Site text)"}),
                ("wait", 4.0),
                ("point", {"within": DRAWER, "css": ".site-preview"}),
                ("wait", 3.0),
                ("point", {"within": DRAWER, "role": "button", "name": "บันทึกข้อความหน้าเว็บ (Save site text)"}),
            ],
        },
        {
            "say": "ส่วน โลโก้และไอคอน อัปโหลดไอคอนแท็บและโลโก้ได้ ใช้ไฟล์ PNG SVG หรือ ICO หน้าเว็บจริงจะเปลี่ยนภายในประมาณหนึ่งนาที เสร็จแล้วกด ปิด",
            "do": [
                ("scroll", {"within": DRAWER, "text": "โลโก้และไอคอน (Logo and favicon)"}),
                ("point", {"within": DRAWER, "text": "โลโก้และไอคอน (Logo and favicon)"}),
                ("wait", 5.0),
                ("click", {"within": DRAWER, "role": "button", "name": "ปิด (Close)"}),
            ],
        },
        {
            "say": "ถ้าจะเปิดแบรนด์ใหม่ที่ใช้ค่าคล้ายกัน กด ทำสำเนา ใส่โดเมนใหม่ ระบบจะสร้างฉบับร่างแล้วเปิดวิซาร์ดให้ทำต่อ ตัวอย่างนี้กด ยกเลิก",
            "do": [
                ("scroll", {"within": DETAIL, "role": "button", "name": "ทำสำเนา (Duplicate)"}),
                ("click", {"within": DETAIL, "role": "button", "name": "ทำสำเนา (Duplicate)"}),
                ("wait", 1.0),
                ("point", {"label": "โดเมนใหม่ (New domain)", "exact": False}),
                ("wait", 3.0),
                ("click", {"role": "button", "name": "ยกเลิก (Cancel)"}),
            ],
        },
        {
            "say": "กด ไทม์ไลน์ เพื่อดูทุกการเปลี่ยนแปลงของแบรนด์นี้ เรียงตามวัน ทั้งการแก้ค่า การติดตั้ง และเหตุการณ์ของบัญชีโฆษณา เลือกช่วงเวลาได้ด้านบน",
            "do": [
                ("click", {"within": DETAIL, "role": "link", "name": "ไทม์ไลน์ (Timeline)"}),
                ("wait", 1.0),
                ("click", {"within": "[aria-label='ช่วงเวลา (Range)']", "role": "button", "name": "30 วัน"}),
                ("wait", 1.0),
                ("point", {"css": "section[aria-label='รายการ (Timeline)']"}),
            ],
        },
        {
            "say": "ถ้าบัญชีโฆษณาถูกระงับ หรือโฆษณาถูกปฏิเสธ ให้จดไว้ในกล่อง บันทึกเหตุการณ์ เลือกประเภท เวลา และหมายเหตุ แล้วกด บันทึก ทุกคนจะเห็นเหตุการณ์นี้ในไทม์ไลน์",
            "do": [
                ("scroll", {"css": "section[aria-label='บันทึกเหตุการณ์ (Add event)']"}),
                ("point", {"css": "section[aria-label='บันทึกเหตุการณ์ (Add event)']"}),
                ("wait", 4.0),
                ("point", {"within": "section[aria-label='บันทึกเหตุการณ์ (Add event)']", "role": "button", "name": "บันทึก (Save)"}),
            ],
        },
        {
            "say": "ตอนต่อไป สอนนำเข้าเทมเพลตและคีย์ Builder",
            "do": [("card", "ตอนต่อไป", "เทมเพลต", "นำเข้า ZIP หรือ URL และคีย์ Builder")],
        },
    ],
}
