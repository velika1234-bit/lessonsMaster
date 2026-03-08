import { Download, Edit2, Layout, Play, Trash2 } from 'lucide-react';
import { Button } from '../ui/Button';

interface PresentationItem {
  id: string;
  title?: string;
}

interface PresentationsListProps {
  presentations: PresentationItem[];
  onEdit: (id: string) => void;
  onHost: (id: string) => void;
  onExport: (presentation: PresentationItem) => void;
  onDelete: (id: string) => void;
}

export const PresentationsList = ({
  presentations,
  onEdit,
  onHost,
  onExport,
  onDelete
}: PresentationsListProps) => {
  if (presentations.length === 0) {
    return (
      <div className="text-center py-20 bg-gray-50 rounded-3xl border-2 border-dashed border-gray-200 m-4">
        <p className="text-gray-400">Нямате създадени презентации още.</p>
      </div>
    );
  }

  return (
    <>
      {presentations.map((presentation) => (
        <div
          key={presentation.id}
          className="flex items-center justify-between gap-4 px-6 py-4 border-b border-gray-100 last:border-b-0 hover:bg-indigo-50/40 transition-colors"
        >
          <div className="min-w-0 flex items-center gap-4">
            <div className="p-2.5 bg-indigo-50 rounded-xl text-indigo-600 shrink-0">
              <Layout className="w-5 h-5" />
            </div>
            <h3 className="text-base font-black text-gray-900 truncate">{presentation.title || 'Без заглавие'}</h3>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="secondary" className="h-10 px-4" onClick={() => onEdit(presentation.id)} title="Редактиране">
              <Edit2 className="w-4 h-4 text-indigo-600" /> Редактирай
            </Button>
            <Button variant="primary" className="h-10 px-4" onClick={() => onHost(presentation.id)} title="Стартиране на урок">
              <Play className="w-4 h-4 text-white fill-current" /> Пусни
            </Button>
            <Button variant="secondary" className="h-10 px-3" onClick={() => onExport(presentation)} title="Изтегляне на файл">
              <Download className="w-4 h-4 text-indigo-600" />
            </Button>
            <Button variant="danger" className="h-10 px-3" onClick={() => onDelete(presentation.id)} title="Изтриване">
              <Trash2 className="w-4 h-4 text-rose-600" />
            </Button>
          </div>
        </div>
      ))}
    </>
  );
};
