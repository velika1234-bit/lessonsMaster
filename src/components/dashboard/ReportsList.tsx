import { Award, BarChart3, History, Trash2, Users } from 'lucide-react';
import { Button } from '../ui/Button';

interface ReportItem {
  id: string;
  createdAt?: string;
  presentationTitle?: string;
  data?: {
    students?: Array<{ score: number }>;
  };
}

interface ReportsListProps {
  reports: ReportItem[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}

export const ReportsList = ({ reports, onOpen, onDelete }: ReportsListProps) => {
  if (reports.length === 0) {
    return (
      <div className="text-center py-20 bg-gray-50 rounded-3xl border-2 border-dashed border-gray-200 m-4">
        <p className="text-gray-400">Все още нямате записани доклади.</p>
      </div>
    );
  }

  return (
    <>
      {reports.map((report) => (
        <div
          key={report.id}
          className="flex items-center justify-between gap-4 px-6 py-4 border-b border-gray-100 last:border-b-0 hover:bg-indigo-50/40 transition-colors"
        >
          <div className="min-w-0 flex items-center gap-4">
            <div className="p-2.5 bg-indigo-50 rounded-xl text-indigo-600 shrink-0">
              <History className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-black text-gray-900 truncate">{report.presentationTitle}</h3>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-bold text-gray-400 mt-1">
                <span>{report.createdAt ? new Date(report.createdAt).toLocaleDateString('bg-BG') : '...'}</span>
                <span className="flex items-center gap-1"><Users className="w-3 h-3 text-indigo-500" /> {report.data?.students?.length || 0}</span>
                <span className="flex items-center gap-1 text-emerald-500"><Award className="w-3 h-3" /> {report.data?.students ? Math.max(...report.data.students.map((s) => s.score), 0) : 0} макс.</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="secondary" className="h-10 px-4" onClick={() => onOpen(report.id)}>
              <BarChart3 className="w-4 h-4 text-indigo-600" /> Преглед
            </Button>
            <Button variant="danger" className="h-10 px-3" onClick={() => onDelete(report.id)}>
              <Trash2 className="w-4 h-4 text-rose-600" />
            </Button>
          </div>
        </div>
      ))}
    </>
  );
};
