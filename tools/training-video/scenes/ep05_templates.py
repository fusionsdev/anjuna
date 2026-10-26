"""Video 5: builder keys and template import (employee view). Keys are blurred; nothing is created or imported."""

SCENE = {
    "title": "ตอน 5 เทมเพลตและคีย์ Builder",
    "steps": [
        {
            "say": "วิดีโอนี้สอนนำเข้าเทมเพลตหน้าเว็บ จาก bolt.new หรือ Open Design และสอนใช้คีย์ Builder",
            "do": [("card", "สอนใช้ Control Panel", "ตอน 5", "เทมเพลตและคีย์ Builder")],
        },
        {
            "say": "เมนู คีย์ Builder ใช้สร้างคีย์ให้ bolt.new หรือ Open Design ส่งเทมเพลตเข้ามาตรวจเอง หนึ่งคนใช้หนึ่งคีย์ ใส่ชื่อคีย์ เช่นชื่อคนและเครื่องมือ แล้วกด สร้างคีย์ คีย์เป็นความลับ ห้ามส่งในแชทกลุ่ม",
            "do": [
                ("goto", "/builder-keys"),
                ("point", {"css": "main table"}),
                ("wait", 4.0),
                ("point", {"role": "textbox", "name": "ชื่อคีย์ (Key label)"}),
                ("wait", 2.0),
                ("point", {"role": "button", "name": "สร้างคีย์ (Create key)"}),
            ],
        },
        {
            "say": "เมนู เทมเพลต รวมเทมเพลตทั้งหมด ปุ่มด้านบนกรองตามสถานะ ใช้ได้ รออนุมัติ ไม่ผ่าน และกำลังตรวจ เทมเพลตใหม่ต้องให้ Owner อนุมัติก่อน จึงจะเลือกในวิซาร์ดได้",
            "do": [
                ("goto", "/templates"),
                ("point", {"css": "[aria-label='กรองสถานะเทมเพลต']"}),
                ("wait", 2.0),
                ("click", {"within": "[aria-label='กรองสถานะเทมเพลต']", "role": "button", "name": "รออนุมัติ", "exact": False}),
                ("wait", 2.0),
                ("click", {"within": "[aria-label='กรองสถานะเทมเพลต']", "role": "button", "name": "ทั้งหมด", "exact": False}),
            ],
        },
        {
            "say": "นำเข้าได้สองแบบ แบบแรกคือไฟล์ ZIP ที่ build แล้ว ใส่ชื่อเทมเพลต ระบบเติมรหัสให้เอง เลือกไฟล์ ระบบจะบอกชนิดที่ตรวจพบ เช่น Astro Bolt หรือ Vite React แล้วกด นำเข้า ZIP",
            "do": [
                ("scroll", {"text": "นำเข้าไฟล์ ZIP", "exact": True}),
                ("type", {"role": "textbox", "name": "ชื่อเทมเพลต ZIP (ZIP template name)"}, "Pastel Lending"),
                ("wait", 1.0),
                ("point", {"role": "textbox", "name": "รหัสเทมเพลต (Template ID)"}),
                ("wait", 2.0),
                ("point", {"label": "ไฟล์ ZIP (ZIP file)"}),
                ("wait", 2.0),
                ("point", {"role": "button", "name": "นำเข้า ZIP (Import ZIP)"}),
            ],
        },
        {
            "say": "แบบที่สองคือลิงก์หน้าเว็บที่เผยแพร่แล้ว เช่นลิงก์ bolt.host ใส่ลิงก์และชื่อเทมเพลต แล้วกด นำเข้า ระบบจะดึงหน้าเว็บมาตรวจ",
            "do": [
                ("scroll", {"text": "นำเข้าจาก URL", "exact": True}),
                ("type", {"role": "textbox", "name": "URL ของเว็บที่เผยแพร่ (Published URL)"}, "https://pastel-lending.bolt.host"),
                ("point", {"role": "button", "name": "นำเข้า (Import)"}),
            ],
        },
        {
            "say": "หลังนำเข้า เทมเพลตจะขึ้นเป็นการ์ด คลิกการ์ดเพื่อดู ผลการตรวจ ข้อที่ไม่ผ่านต้องแก้ใน bolt หรือ Open Design แล้วส่งใหม่ คำเตือนไม่บล็อกการใช้งาน",
            "do": [
                ("scroll", {"css": "main img", "nth": 0}),
                ("click", {"css": "main img", "nth": 0}),
                ("wait", 1.5),
                ("scroll", {"css": "section[aria-label='รายละเอียดเทมเพลต (Template detail)']"}),
                ("point", {"within": "section[aria-label='รายละเอียดเทมเพลต (Template detail)']", "text": "ผลการตรวจ (Checks)"}),
            ],
        },
        {
            "say": "ตอนต่อไป สอนอ่านรายงาน ฟันเนล ทราฟฟิก ข้อผิดพลาด และการแจ้งเตือน",
            "do": [("card", "ตอนต่อไป", "อ่านรายงาน", "ฟันเนล ทราฟฟิก ข้อผิดพลาด การแจ้งเตือน")],
        },
    ],
}
