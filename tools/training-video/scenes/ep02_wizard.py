"""Video 2: create a brand in the 5-step wizard (employee view).

Draft saves are answered in the browser by tv.DraftStub, starting from the real draft below, so nothing is created.
The video stops at Review and points at Generate without clicking it.
"""

WIZ = {"css": "section[aria-label='วิซาร์ดแบรนด์ใหม่ (New brand wizard)']"}
NEXT = {"role": "button", "name": "ถัดไป (Next)"}


def field(label: str) -> dict:
    return {"role": "textbox", "name": label}


SCENE = {
    "title": "ตอน 2 สร้างแบรนด์ใหม่",
    "draft_stub": "brand_f79db02fd08d4a65",  # draft "Test" on demo13.aduplift.ai
    "steps": [
        {
            "say": "วิดีโอนี้สอนสร้างแบรนด์ใหม่ในวิซาร์ด ซึ่งมีห้าขั้น ระบบบันทึกฉบับร่างทุกครั้งที่กด ถัดไป ปิดกลางทางแล้วกลับมาทำต่อได้",
            "do": [("card", "สอนใช้ Control Panel", "ตอน 2", "สร้างแบรนด์ใหม่ในวิซาร์ด 5 ขั้น")],
        },
        {
            "say": "กดเมนู สร้างแบรนด์ใหม่ ด้านบนมีป้ายบอกห้าขั้น คือ แบรนด์ เทมเพลต ข้อความ ติดตามผล และตรวจสอบ",
            "do": [
                ("goto", "/"),
                ("click", {"within": "aside.sidebar nav", "text": "สร้างแบรนด์ใหม่", "exact": True}),
                ("wait", 1.0),
                ("point", {"role": "list", "name": "ขั้นตอน (Steps)"}),
            ],
        },
        {
            "say": "ขั้นแรก ใส่ชื่อแบรนด์ และโดเมนหลักที่ซื้อไว้ ไม่ต้องใส่ www จากนั้นใส่คีย์เวิร์ดเริ่มต้นของโฆษณา",
            "do": [
                ("type", field("ชื่อแบรนด์ (Brand name)"), "Demo Lending"),
                ("type", field("โดเมน (Domain)"), "demo13.aduplift.ai"),
                ("type", field("คีย์เวิร์ด (Keyword)"), "Demo13"),
            ],
        },
        {
            "say": "กด ตรวจโซน Cloudflare เพื่อเช็คว่าโดเมนนี้พร้อมใช้ ถ้าขึ้นว่าโซน active และไม่มี record ที่ขวาง ก็ไปต่อได้ ถ้าไม่พบโซน ให้แจ้ง Owner ก่อน",
            "do": [
                ("click", {"role": "button", "name": "ตรวจโซน Cloudflare (Check Cloudflare zone)"}),
                ("wait", 3.0),
                ("point", {"within": WIZ["css"], "css": ".note", "nth": 0}),
            ],
        },
        {
            "say": "ใส่เบอร์โทร ที่อยู่ และอีเมลติดต่อของแบรนด์ ข้อมูลนี้จะขึ้นบนหน้าเว็บ แล้วกด ถัดไป",
            "do": [
                ("type", field("โทรศัพท์ (Phone)"), "+1 (555) 010-0199"),
                ("type", field("ที่อยู่ (Address)"), "12 Main St, Austin, TX 78701"),
                ("type", field("อีเมล (Email)"), "help@example.com"),
                ("click", NEXT),
            ],
        },
        {
            "say": "ขั้นที่สอง เลือกเทมเพลต การ์ดแต่ละใบบอกว่ามีแบรนด์ใช้อยู่กี่แบรนด์ แต่ละแบรนด์ควรใช้เทมเพลตไม่ซ้ำกัน ด้านล่างเลือกสีหลักและสีรองได้ หรือกด ใช้สีของเทมเพลต",
            "do": [
                ("click", {"within": WIZ["css"], "css": "button[aria-pressed]", "has_text": "Willow"}),
                ("wait", 1.5),
                ("scroll", {"text": "สีแบรนด์ (Brand colors)"}),
                ("point", {"text": "สีแบรนด์ (Brand colors)"}),
                ("wait", 2.0),
                ("click", NEXT),
            ],
        },
        {
            "say": "ขั้นที่สาม ข้อความบนหน้าเว็บ ช่องที่เว้นว่างจะใช้ข้อความของเทมเพลต ถ้าจะเขียนหัวข้อหลักเอง ให้ใส่คำว่า keyword ในวงเล็บปีกกาหนึ่งครั้ง ระบบจะแทนด้วยคีย์เวิร์ดของโฆษณา",
            "do": [
                ("point", field("หัวข้อหลัก H1 (Headline)")),
                ("wait", 5.0),
                ("click", NEXT),
            ],
        },
        {
            "say": "ขั้นที่สี่ ติดตามผล ใส่บัญชี Google Ads และโปรเจกต์ AdKit ถ้ายังไม่มี เว้นว่างไว้ก่อนได้ Owner จะใส่ให้ภายหลัง",
            "do": [
                ("point", field("บัญชี Google Ads (Google Ads account)")),
                ("wait", 3.0),
                ("click", NEXT),
            ],
        },
        {
            "say": "ขั้นสุดท้าย ตรวจสอบ สรุปทุกค่าที่กรอกไว้ ระบบตรวจโซนอีกรอบ และแสดงตัวอย่างหน้าเว็บก่อนติดตั้ง เลื่อนดูให้ครบก่อน",
            "do": [
                ("point", {"within": WIZ["css"], "text": "สรุป (Summary)"}),
                ("wait", 3.0),
                ("scroll", {"css": "iframe[title='ตัวอย่างหน้าเว็บ (Site preview)']"}),
                ("point", {"css": "iframe[title='ตัวอย่างหน้าเว็บ (Site preview)']"}),
            ],
        },
        {
            "say": "เมื่อทุกอย่างถูกต้อง กด สร้างเว็บไซต์ ระบบจะเริ่มติดตั้งทันที และพาไปหน้าแบรนด์เพื่อดูความคืบหน้า ปุ่มนี้กดครั้งเดียวพอ",
            "do": [("point", {"role": "button", "name": "สร้างเว็บไซต์ (Generate)"})],
        },
        {
            "say": "ตอนต่อไป สอนติดตามการติดตั้งและรายการตรวจสี่ข้อ",
            "do": [("card", "ตอนต่อไป", "ติดตามการติดตั้ง", "และรายการตรวจ 4 ข้อ")],
        },
    ],
}
