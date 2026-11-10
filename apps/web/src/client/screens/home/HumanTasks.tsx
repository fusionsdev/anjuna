import { ChevronRight } from "lucide-react";
import { num, type Value } from "./shared";

export interface HumanTask { id: string; title: string; count: Value; unit: string; show: boolean; onOpen: () => void }

/** The work only a person can do. A count of 0 says nothing is waiting and offers no button; "—" means the count could not be read. */
export function HumanTasks({ tasks }: { tasks: HumanTask[] }) {
  return (
    <section className="panel" aria-label="งานที่ต้องใช้คน">
      <h2>งานที่ต้องใช้คน</h2>
      {tasks.filter((task) => task.show).map((task) => (
        <div className="home-item" key={task.id}>
          <div className="t">{task.title}<span>{task.count === 0 ? "ไม่มีงานค้าง" : `${num(task.count)} ${task.unit}`}</span></div>
          {task.count !== 0 && <button type="button" className="btn home-task-link" onClick={task.onOpen}>เปิด<ChevronRight size={16} aria-hidden="true" /></button>}
        </div>
      ))}
      <p className="hint" style={{ marginTop: 8 }}>ระบบทำที่เหลือให้เองแล้ว</p>
    </section>
  );
}
