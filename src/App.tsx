import { QRCodeSVG } from 'qrcode.react';
import { GoogleGenAI } from "@google/genai";
import { nanoid } from 'nanoid';
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Plus, 
  Play, 
  Edit2, 
  Trash2, 
  ChevronRight, 
  ChevronLeft, 
  ChevronUp,
  ChevronDown,
  Users, 
  Layout, 
  Type, 
  CheckSquare, 
  LogOut,
  Send,
  Loader2,
  Image as ImageIcon,
  Video,
  CheckCircle2,
  ListChecks,
  Move,
  X,
  Download,
  BarChart3,
  Award,
  Monitor,
  MapPin,
  MessageSquare,
  Palette,
  Zap,
  FileText,
  ArrowLeft,
  Save,
  Settings,
  XCircle,
  Trophy,
  Link as LinkIcon,
  Shield,
  ShieldCheck
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  BrowserRouter as Router, 
  Routes, 
  Route, 
  useNavigate, 
  useParams,
  useSearchParams,
  Link
} from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Button } from './components/ui/Button';
import { Card } from './components/ui/Card';
import { ReportsList } from './components/dashboard/ReportsList';
import { PresentationsList } from './components/dashboard/PresentationsList';
import { Auth } from './components/auth/Auth';
import type { Presentation, Slide, SlideType, User } from './types/app';
import { auth, db } from './lib/firebase';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { 
  doc, 
  getDoc, 
  collection, 
  query, 
  where, 
  getDocs, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  onSnapshot,
  orderBy,
  serverTimestamp,
  increment
} from 'firebase/firestore';

// --- Helpers ---
const getAvatarUrl = (seed: string) => `https://robohash.org/${seed}?set=set4&bgset=bg1`;

const getYouTubeEmbedUrl = (url: string) => {
  if (!url) return "";
  let videoId = "";
  try {
    if (url.includes("youtube.com/watch")) {
      const urlObj = new URL(url);
      videoId = urlObj.searchParams.get("v") || "";
    } else if (url.includes("youtu.be/")) {
      videoId = url.split("youtu.be/")[1].split(/[?#]/)[0];
    } else if (url.includes("youtube.com/embed/")) {
      videoId = url.split("youtube.com/embed/")[1].split(/[?#]/)[0];
    } else if (url.includes("youtube.com/shorts/")) {
      videoId = url.split("youtube.com/shorts/")[1].split(/[?#]/)[0];
    }
  } catch (e) {
    console.error("Invalid URL", e);
  }
  return videoId ? `https://www.youtube.com/embed/${videoId}` : url;
};

// --- Types ---

// --- Global API Key Management ---
let globalGeminiApiKey = (typeof process !== 'undefined' ? process.env.GEMINI_API_KEY : '') || '';

const fetchConfig = async () => {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    if (data.geminiApiKey) {
      globalGeminiApiKey = data.geminiApiKey;
    }
  } catch (err) {
    console.error("Failed to fetch config:", err);
  }
};

fetchConfig();

const getAIInstance = () => {
  const key = globalGeminiApiKey || (typeof process !== 'undefined' ? process.env.GEMINI_API_KEY : '') || (typeof process !== 'undefined' ? process.env.API_KEY : '');
  if (!key) return null;
  // Always create a new instance to use the latest key from the environment
  return new GoogleGenAI({ apiKey: key });
};

// --- Components ---


const isResponseCorrectForSlide = (slide: any, response: any) => {
  if (response === undefined || response === null) return false;

  if (slide.type === 'quiz-single' || slide.type === 'boolean') {
    const correctIdx = slide.content.options?.findIndex((o: any) => o.isCorrect);
    return response === correctIdx;
  }

  if (slide.type === 'quiz-multi') {
    const correctIndices = (slide.content.options || [])
      .map((o: any, i: number) => (o.isCorrect ? i : -1))
      .filter((i: number) => i !== -1);
    return Array.isArray(response)
      && response.length === correctIndices.length
      && response.every((r: any) => correctIndices.includes(r));
  }

  if (slide.type === 'hotspot') {
    const hotspot = slide.content.hotspot;
    if (!hotspot || typeof response?.x !== 'number' || typeof response?.y !== 'number') return false;
    const dist = Math.sqrt(Math.pow(response.x - hotspot.x, 2) + Math.pow(response.y - hotspot.y, 2));
    return dist <= hotspot.radius;
  }

  if (slide.type === 'labeling') {
    const labels = slide.content.labels || [];
    if (!labels.length || !response || typeof response !== 'object') return false;
    let correctCount = 0;
    labels.forEach((label: any) => {
      const pos = response[label.id];
      if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return;
      const dist = Math.sqrt(Math.pow(pos.x - label.x, 2) + Math.pow(pos.y - label.y, 2));
      if (dist < 14) correctCount++;
    });
    return correctCount === labels.length;
  }

  if (slide.type === 'matching') {
    const pairs = slide.content.pairs || [];
    if (pairs.length === 0 || !response || typeof response !== 'object') return false;
    return pairs.every((p: any) => response[p.id] === p.id);
  }

  if (slide.type === 'ordering') {
    const orderingItems = slide.content.orderingItems || [];
    if (!Array.isArray(response) || response.length !== orderingItems.length) return false;
    return orderingItems.every((item: any, index: number) => response[index] === item.id || response[index] === item.text);
  }

  if (slide.type === 'categorization') {
    const categoryItems = slide.content.categoryItems || [];
    if (!categoryItems.length || !response) return false;
    if (Array.isArray(response)) {
      return categoryItems.every((item: any) => {
        const found = response.find((entry: any) => entry?.id === item.id || entry?.text === item.text);
        return found?.category === item.category;
      });
    }
    if (typeof response !== 'object') return false;
    return categoryItems.every((item: any) => response[item.id] === item.category || response[item.text] === item.category);
  }

  return false;
};

const getResponseForSlide = (student: any, index: number, slide?: any) => {
  const rawResponses = student?.responses;
  if (rawResponses == null) return undefined;

  const responses = typeof rawResponses === 'string'
    ? (() => {
        try { return JSON.parse(rawResponses); } catch { return rawResponses; }
      })()
    : rawResponses;

  if (Array.isArray(responses)) return responses[index];
  if (typeof responses === 'object') {
    if (responses[index] !== undefined) return responses[index];
    if (responses[String(index)] !== undefined) return responses[String(index)];
    if (slide?.id && responses[slide.id] !== undefined) return responses[slide.id];
  }

  return undefined;
};

// --- Auth Components ---

// --- Pages ---

// --- Components ---

const ReportsDashboard = ({ user }: { user: User }) => {
  const [reports, setReports] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();


  useEffect(() => {
    const fetchReports = async () => {
      try {
        const res = await fetch('/api/reports', {
          headers: { 'teacher-id': user.id }
        });
        if (!res.ok) throw new Error('Failed to fetch');
        const data = await res.json();
        setReports(data);
      } catch (error) {
        console.error("Error fetching reports:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchReports();
  }, [user.id]);

  const deleteReport = async (id: string) => {
    if (!confirm('Сигурни ли сте, че искате да изтриете този доклад?')) return;
    try {
      setReports(prev => prev.filter(r => r.id !== id));
      const res = await fetch(`/api/reports/${id}`, {
        method: 'DELETE',
        headers: { 'teacher-id': user.id }
      });
      if (!res.ok) throw new Error('Delete failed');
    } catch (err) {
      console.error("Delete report failed", err);
      alert("Грешка при изтриването на доклада.");
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-8">
      <div className="flex justify-between items-center mb-12">
        <div>
          <h1 className="text-4xl font-black text-gray-900 mb-2 tracking-tight">Архив на сесиите</h1>
          <p className="text-gray-400 font-medium">Прегледайте резултатите от проведените уроци.</p>
        </div>
        <Button variant="secondary" onClick={() => navigate('/')} className="px-6">
          <ArrowLeft className="w-4 h-4" /> Обратно
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="w-12 h-12 animate-spin text-indigo-600" />
        </div>
      ) : (
        <div className="bg-white rounded-3xl border border-gray-100 overflow-hidden">
          <ReportsList
            reports={reports}
            onOpen={(reportId) => navigate(`/reports/${reportId}`)}
            onDelete={deleteReport}
          />
        </div>
      )}
    </div>
  );
};

const ReportDetail = ({ user }: { user: User }) => {
  const { id } = useParams();
  const [report, setReport] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const reportAnalytics = useMemo(() => {
    if (!report?.data?.students) return null;

    const students = [...report.data.students].sort((a: any, b: any) => b.score - a.score);
    const totalStudents = students.length;
    const totalSlides = report.data?.slides?.length || 0;
    const averageScore = totalStudents
      ? students.reduce((acc: number, s: any) => acc + (s.score || 0), 0) / totalStudents
      : 0;


    const answerableSlideTypes = new Set(['quiz-single', 'quiz-multi', 'boolean', 'hotspot', 'labeling', 'matching', 'ordering', 'categorization']);
    const slideStats = (report.data?.slides || [])
      .map((slide: any, idx: number) => {
        if (!answerableSlideTypes.has(slide.type)) return null;
        const responses = students
          .map((student: any) => getResponseForSlide(student, idx, slide))
          .filter((response: any) => response !== undefined && response !== null);

        const correctCount = responses.filter((response: any) => isResponseCorrectForSlide(slide, response)).length;
        const participation = totalStudents ? (responses.length / totalStudents) * 100 : 0;
        const accuracy = responses.length ? (correctCount / responses.length) * 100 : 0;

        return {
          index: idx,
          title: slide.content?.title || `Въпрос ${idx + 1}`,
          type: slide.type,
          responsesCount: responses.length,
          correctCount,
          participation,
          accuracy,
        };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => b.accuracy - a.accuracy);

    return {
      students,
      totalStudents,
      totalSlides,
      averageScore,
      topStudent: students[0],
      lowStudent: students[students.length - 1],
      slideStats,
    };
  }, [report]);

  useEffect(() => {
    const fetchReport = async () => {
      try {
        const res = await fetch(`/api/reports/${id}`, {
          headers: { 'teacher-id': user.id }
        });
        if (!res.ok) throw new Error('Failed to fetch');
        const data = await res.json();
        setReport(data);
      } catch (err) {
        console.error("Error fetching report:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchReport();
  }, [id, user.id]);

  const downloadPDF = async () => {
    const doc = new jsPDF();
    
    try {
      const fontUrl = 'https://cdn.jsdelivr.net/gh/googlefonts/roboto@main/src/hinted/Roboto-Regular.ttf';
      const fontRes = await fetch(fontUrl);
      const fontBuffer = await fontRes.arrayBuffer();
      const fontBase64 = btoa(
        new Uint8Array(fontBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
      );
      doc.addFileToVFS('Roboto-Regular.ttf', fontBase64);
      doc.addFont('Roboto-Regular.ttf', 'Roboto', 'normal');
      doc.setFont('Roboto');
    } catch (e) {
      console.warn("Could not load Cyrillic font", e);
    }

    doc.setFontSize(22);
    doc.text("Отчет от презентация", 105, 20, { align: "center" });
    
    doc.setFontSize(16);
    doc.text(report.presentationTitle || 'Без заглавие', 105, 30, { align: "center" });
    
    doc.setFontSize(12);
    const dateStr = report.createdAt ? new Date(report.createdAt).toLocaleDateString('bg-BG') : '...';
    doc.text(`Дата: ${dateStr}`, 20, 45);
    
    const sortedStudents = [...(report.data.students || [])].sort((a: any, b: any) => b.score - a.score);
    const tableData = sortedStudents.map((student: any, i: number) => [i + 1, student.name, student.score]);

    autoTable(doc, {
      startY: 60,
      head: [['#', 'Име на ученик', 'Точки']],
      body: tableData,
      theme: 'striped',
      headStyles: { fillColor: [79, 70, 229], font: 'Roboto', fontStyle: 'normal' },
      styles: { font: 'Roboto', fontStyle: 'normal' }
    });

    let currentY = (doc as any).lastAutoTable.finalY + 20;
    doc.setFontSize(16);
    doc.text("Анализ по въпроси", 20, currentY);
    currentY += 10;

    const questionStats = (report.data.slides || [])
      .map((slide: any, idx: number) => {
        if (!['quiz-single', 'quiz-multi', 'boolean', 'hotspot', 'labeling', 'matching', 'ordering', 'categorization'].includes(slide.type)) return null;
        const responses = sortedStudents.map((student: any) => getResponseForSlide(student, idx, slide)).filter((response: any) => response !== undefined && response !== null);
        const correctCount = responses.filter((response: any) => isResponseCorrectForSlide(slide, response)).length;
        const accuracy = responses.length ? (correctCount / responses.length) * 100 : 0;
        const participation = sortedStudents.length ? (responses.length / sortedStudents.length) * 100 : 0;

        return {
          idx,
          title: slide.content?.title || `Въпрос ${idx + 1}`,
          accuracy,
          participation,
          correctCount,
          responses: responses.length,
        };
      })
      .filter(Boolean);

    questionStats.forEach((item: any) => {
      if (currentY > 250) {
        doc.addPage();
        currentY = 20;
        doc.setFont('Roboto');
      }

      doc.setFontSize(12);
      doc.text(`${item.idx + 1}. ${item.title}`, 20, currentY);
      currentY += 7;
      doc.text(`Успеваемост: ${item.accuracy.toFixed(1)}% (${item.correctCount}/${item.responses})`, 20, currentY);
      currentY += 7;
      doc.text(`Участие: ${item.participation.toFixed(1)}%`, 20, currentY);
      currentY += 10;
    });

    doc.save(`report-${report.id}.pdf`);
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="w-12 h-12 animate-spin text-indigo-600" />
      </div>
    );
  }

  if (!report) {
    return (
      <div className="max-w-4xl mx-auto p-8 text-center">
        <XCircle className="w-16 h-16 text-rose-500 mx-auto mb-4" />
        <h2 className="text-2xl font-bold mb-2">Докладът не е намерен</h2>
        <Button variant="ghost" onClick={() => navigate('/reports')} className="mx-auto">
          <ArrowLeft className="w-4 h-4" /> Обратно към списъка
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-8">
      <div className="flex justify-between items-center mb-12">
        <Button variant="ghost" onClick={() => navigate('/reports')}>
          <ArrowLeft className="w-4 h-4" /> Обратно
        </Button>
        <Button variant="primary" onClick={downloadPDF}>
          <Download className="w-4 h-4" /> Изтегли PDF
        </Button>
      </div>

      <Card className="mb-8">
        <h1 className="text-3xl font-black mb-2">{report.presentationTitle}</h1>
        <p className="text-gray-500">
          Проведена на {report.createdAt?.toDate ? report.createdAt.toDate().toLocaleString('bg-BG') : '...'}
        </p>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
        <Card className="text-center">
          <div className="text-3xl font-black text-indigo-600 mb-1">{reportAnalytics?.totalStudents || 0}</div>
          <div className="text-xs font-bold text-gray-400 uppercase">Ученици</div>
        </Card>
        <Card className="text-center">
          <div className="text-3xl font-black text-green-600 mb-1">{Math.round(reportAnalytics?.averageScore || 0)}</div>
          <div className="text-xs font-bold text-gray-400 uppercase">Среден резултат</div>
        </Card>
        <Card className="text-center">
          <div className="text-3xl font-black text-orange-600 mb-1">{reportAnalytics?.totalSlides || 0}</div>
          <div className="text-xs font-bold text-gray-400 uppercase">Слайда</div>
        </Card>
        <Card className="text-center">
          <div className="text-3xl font-black text-purple-600 mb-1">{Math.round((reportAnalytics?.slideStats?.reduce((acc: number, s: any) => acc + s.accuracy, 0) || 0) / ((reportAnalytics?.slideStats?.length || 1))) || 0}%</div>
          <div className="text-xs font-bold text-gray-400 uppercase">Средна успеваемост</div>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <Card>
          <h2 className="text-lg font-black mb-4">Топ представяне</h2>
          {reportAnalytics?.topStudent ? (
            <div className="flex items-center justify-between p-4 bg-emerald-50 rounded-xl border border-emerald-100">
              <span className="font-bold text-emerald-900">{reportAnalytics.topStudent.name}</span>
              <span className="text-emerald-700 font-black">{reportAnalytics.topStudent.score} т.</span>
            </div>
          ) : (
            <p className="text-sm text-gray-500">Няма налични данни.</p>
          )}
        </Card>
        <Card>
          <h2 className="text-lg font-black mb-4">Най-нисък резултат</h2>
          {reportAnalytics?.lowStudent ? (
            <div className="flex items-center justify-between p-4 bg-amber-50 rounded-xl border border-amber-100">
              <span className="font-bold text-amber-900">{reportAnalytics.lowStudent.name}</span>
              <span className="text-amber-700 font-black">{reportAnalytics.lowStudent.score} т.</span>
            </div>
          ) : (
            <p className="text-sm text-gray-500">Няма налични данни.</p>
          )}
        </Card>
      </div>

      <Card className="mb-8">
        <h2 className="text-xl font-bold mb-6">Успеваемост по въпроси</h2>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={(reportAnalytics?.slideStats || []).slice(0, 12).map((slide: any) => ({
              name: `#${slide.index + 1}`,
              accuracy: Number(slide.accuracy.toFixed(1)),
              participation: Number(slide.participation.toFixed(1)),
            }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="name" tick={{ fill: '#64748b', fontSize: 12 }} />
              <YAxis domain={[0, 100]} tick={{ fill: '#64748b', fontSize: 12 }} />
              <Tooltip />
              <Bar dataKey="accuracy" name="Успеваемост %" fill="#4f46e5" radius={[8, 8, 0, 0]} />
              <Bar dataKey="participation" name="Участие %" fill="#10b981" radius={[8, 8, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card className="mb-8">
        <h2 className="text-xl font-bold mb-6">Резултати по ученици</h2>
        <div className="space-y-4">
          {(reportAnalytics?.students || []).map((student: any, idx: number) => (
            <div key={idx} className="flex items-center justify-between p-4 bg-gray-50 rounded-xl">
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center font-bold text-indigo-600 shadow-sm">
                  {idx + 1}
                </div>
                <span className="font-bold text-gray-700">{student.name}</span>
              </div>
              <div className="text-sm font-bold text-indigo-600">{student.score} т.</div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <h2 className="text-xl font-bold mb-6">Детайл по въпроси</h2>
        <div className="space-y-3">
          {(reportAnalytics?.slideStats || []).map((slide: any) => (
            <div key={slide.index} className="p-4 rounded-xl border border-gray-100 bg-white">
              <div className="flex justify-between items-center gap-3 mb-2">
                <div className="font-semibold text-gray-800">#{slide.index + 1} • {slide.title}</div>
                <div className="text-sm font-bold text-indigo-600">{slide.accuracy.toFixed(1)}%</div>
              </div>
              <div className="w-full bg-gray-100 h-2 rounded-full overflow-hidden mb-2">
                <div className="h-full bg-indigo-500" style={{ width: `${Math.max(0, Math.min(100, slide.accuracy))}%` }} />
              </div>
              <div className="text-xs text-gray-500">Отговорили: {slide.responsesCount}/{reportAnalytics?.totalStudents || 0} • Верни: {slide.correctCount}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
};

const Dashboard = ({ user, onLogout }: { user: User, onLogout: () => void }) => {
  const [presentations, setPresentations] = useState<Presentation[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAiModal, setShowAiModal] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiSourceText, setAiSourceText] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const navigate = useNavigate();


  useEffect(() => {
    const fetchPresentations = async () => {
      try {
        const res = await fetch('/api/presentations', {
          headers: { 'teacher-id': user.id }
        });
        if (!res.ok) throw new Error('Failed to fetch');
        const data = await res.json();
        setPresentations(data);
      } catch (error) {
        console.error("Error fetching presentations:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchPresentations();
    // Poll for updates every 10 seconds since we don't have real-time sync for the list anymore
    const interval = setInterval(fetchPresentations, 10000);
    return () => clearInterval(interval);
  }, [user.id]);

  const createNew = async () => {
    try {
      const res = await fetch('/api/presentations', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'teacher-id': user.id
        },
        body: JSON.stringify({ title: 'Нова презентация' })
      });
      const data = await res.json();
      navigate(`/edit/${data.id}`);
    } catch (err) {
      alert('Грешка при създаване на урок.');
    }
  };

  const generatePresentationWithAI = async () => {
    if (!aiPrompt.trim() && !aiSourceText.trim()) return;
    
    if (!globalGeminiApiKey) await fetchConfig();
    let ai = getAIInstance();
    
    if (!ai && (window as any).aistudio) {
      const hasKey = await (window as any).aistudio.hasSelectedApiKey();
      if (!hasKey) await (window as any).aistudio.openSelectKey();
      ai = getAIInstance();
    }

    if (!ai) {
      alert('Моля, конфигурирайте Gemini API ключ.');
      return;
    }

    setIsGenerating(true);
    try {
      const systemInstruction = `Вие сте експерт по образование. Генерирайте JSON обект за нова презентация на български език.
      Формат: { "title": "...", "slides": [{ "type": "...", "content": { "title": "...", "body": "...", "options": [...], "imageUrl": "...", "hotspot": {...}, "labels": [...] } }] }
      Налични типове слайдове: title, text-image, quiz-single, quiz-multi, open-question, boolean, hotspot, labeling, matching, ordering, categorization.
      Генерирайте между 5 и 10 слайда. Смесете информация с интерактивни въпроси.`;

      const userPrompt = `Създай цялостна презентация въз основа на следното:
      Тема: ${aiPrompt}
      Изходен текст: ${aiSourceText}`;

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: userPrompt,
        config: { systemInstruction, responseMimeType: "application/json" }
      });

      const generatedData = JSON.parse(response.text);
      
      const res = await fetch('/api/presentations', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'teacher-id': user.id
        },
        body: JSON.stringify({
          title: generatedData.title || aiPrompt || 'Нова презентация',
          slides: generatedData.slides.map((s: any) => ({ ...s, id: nanoid(10) }))
        })
      });

      const data = await res.json();
      navigate(`/edit/${data.id}`);
    } catch (error: any) {
      console.error("AI Generation failed:", error);
      alert(`Грешка при генерирането: ${error.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const uploadPresentation = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const content = e.target?.result as string;
        const imported = JSON.parse(content);
        
        if (typeof imported !== 'object' || imported === null) {
          throw new Error('Invalid JSON format');
        }

        // Remove the old ID if it exists
        const { id, ...presentationData } = imported;
        
        const res = await fetch('/api/presentations', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'teacher-id': user.id
          },
          body: JSON.stringify({
            ...presentationData,
            teacherId: user.id
          })
        });

        if (!res.ok) throw new Error('Upload failed');
        
        alert('Урокът е качен успешно!');
        // Refresh the list
        const listRes = await fetch('/api/presentations', {
          headers: { 'teacher-id': user.id }
        });
        if (listRes.ok) {
          const data = await listRes.json();
          setPresentations(data);
        }
        
        // Reset input so the same file can be selected again
        event.target.value = '';
      } catch (err) {
        console.error("Upload error:", err);
        alert('Невалиден файл или грешка при качване.');
      }
    };
    reader.readAsText(file);
  };

  const exportPresentation = async (p: Presentation) => {
    const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${p.title.replace(/\s+/g, '_')}.json`;
    a.click();
  };

  const deletePresentation = async (id: string) => {
    if (!id) return;
    if (!confirm('Сигурни ли сте, че искате да изтриете този урок?')) return;
    
    try {
      setPresentations(prev => prev.filter(p => p.id !== id));
      const res = await fetch(`/api/presentations/${id}`, {
        method: 'DELETE',
        headers: { 'teacher-id': user.id }
      });
      if (!res.ok) throw new Error('Delete failed');
    } catch (error: any) {
      console.error("Delete failed:", error);
      alert('Възникна грешка при изтриването.');
    }
  };

  const handleLogout = async () => {
    if (!auth) {
      onLogout();
      return;
    }

    await signOut(auth);
    onLogout();
  };

  return (
    <div className="max-w-5xl mx-auto p-8">
      <div className="flex justify-between items-center mb-12">
        <div className="flex items-center gap-6">
          <div className="w-16 h-16 bg-indigo-500 rounded-3xl flex items-center justify-center text-white shadow-2xl shadow-indigo-200">
            <Monitor className="w-8 h-8" />
          </div>
          <div>
            <h1 className="text-4xl font-black text-gray-900 tracking-tight">Здравейте, {user.name}!</h1>
            <div className="flex items-center gap-2 text-emerald-500 font-bold text-[10px] uppercase tracking-widest mt-1">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Облачна синхронизация: Активна
            </div>
          </div>
        </div>
        <div className="flex gap-3">
          <Button variant="secondary" onClick={() => navigate('/reports')}>
            <FileText className="w-4 h-4" /> Доклади
          </Button>
          <Button variant="ghost" onClick={handleLogout} className="text-red-500 hover:bg-red-50">
            <LogOut className="w-4 h-4" /> Изход
          </Button>
        </div>
      </div>

        <div className="flex justify-between items-center mb-8 bg-white/60 backdrop-blur-xl p-6 rounded-[2rem] border border-white shadow-xl shadow-slate-200/50">
          <div className="flex gap-4">
            <Button onClick={createNew} className="h-12 px-8">
              <Plus className="w-5 h-5" /> Нов Урок
            </Button>
            <Button onClick={() => setShowAiModal(true)} variant="secondary" className="h-12 px-6 border-indigo-200 text-indigo-600">
              <Zap className="w-5 h-5" /> Създай с AI
            </Button>
            <label className="cursor-pointer">
              <div className="h-12 px-6 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 bg-white text-gray-600 border border-gray-100 hover:bg-indigo-50 hover:text-indigo-600 active:scale-95 shadow-sm">
                <Download className="w-4 h-4" /> Качи урок
              </div>
              <input type="file" className="hidden" accept=".json" onChange={uploadPresentation} />
            </label>
          </div>
          <div className="flex items-center gap-6">
            <div className="flex flex-col items-end">
              <div className="text-[10px] font-black text-indigo-300 uppercase tracking-[0.2em]">
                {presentations.length} ПРЕЗЕНТАЦИИ
              </div>
              <button 
                onClick={async () => {
                  if (confirm('ВНИМАНИЕ: Това ще изтрие ВСИЧКИ ваши уроци и отчети от сървъра завинаги. Сигурни ли сте?')) {
                    await fetch('/api/user/purge', { 
                      method: 'POST', 
                      headers: { 'teacher-id': user.id } 
                    });
                    window.location.reload();
                  }
                }}
                className="text-[9px] text-red-400 hover:text-red-600 font-bold uppercase mt-1 transition-colors"
              >
                Изтрий всички мои данни
              </button>
            </div>
          </div>
        </div>

        <div className="mb-12 bg-emerald-50 border border-emerald-100 p-6 rounded-3xl flex items-start gap-4">
          <ShieldCheck className="w-6 h-6 text-emerald-500 mt-1" />
          <div>
            <h4 className="font-bold text-emerald-900">Вашите данни са защитени</h4>
            <p className="text-sm text-emerald-700 leading-relaxed">
              Системата използва <b>ефимерно съхранение</b>. Данните на учениците се пазят само по време на активната сесия. 
              Отчетите се съхраняват в защитен архив и можете да ги изтривате ръчно от секция „Доклади“.
            </p>
          </div>
        </div>

      {/* AI Modal for Dashboard */}
      <AnimatePresence>
        {showAiModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-[2.5rem] w-full max-w-2xl overflow-hidden shadow-2xl"
            >
              <div className="p-8 border-b border-gray-100 flex justify-between items-center bg-indigo-600 text-white">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 bg-white/20 rounded-2xl flex items-center justify-center">
                    <Zap className="w-6 h-6" />
                  </div>
                  <div>
                    <h2 className="text-2xl font-bold">Създай урок с AI</h2>
                    <p className="text-indigo-100 text-sm">Опишете темата и AI ще подготви всичко</p>
                  </div>
                </div>
                <button onClick={() => setShowAiModal(false)} className="p-2 hover:bg-white/10 rounded-full transition-colors">
                  <X className="w-6 h-6" />
                </button>
              </div>
              
              <div className="p-8 space-y-6">
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-2">Тема на урока</label>
                  <input 
                    type="text" 
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    placeholder="напр. Слънчевата система, Българското възраждане..."
                    className="w-full px-5 py-4 rounded-2xl border-2 border-gray-100 focus:border-indigo-500 outline-none transition-all text-lg"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-2">Допълнителен текст или източник (незадължително)</label>
                  <textarea 
                    value={aiSourceText}
                    onChange={(e) => setAiSourceText(e.target.value)}
                    placeholder="Поставете текст от учебник или статия тук..."
                    className="w-full h-40 px-5 py-4 rounded-2xl border-2 border-gray-100 focus:border-indigo-500 outline-none transition-all resize-none"
                  />
                </div>

                <div className="flex gap-4 pt-4">
                  <Button variant="secondary" className="flex-1 h-14" onClick={() => setShowAiModal(false)}>Отказ</Button>
                  <Button variant="primary" className="flex-[2] h-14 text-lg" onClick={generatePresentationWithAI} loading={isGenerating}>
                    Генерирай Урок
                  </Button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
        </div>
      ) : (
        <div className="bg-white rounded-3xl border border-gray-100 overflow-hidden">
          <PresentationsList
            presentations={presentations}
            onEdit={(presentationId) => navigate(`/edit/${presentationId}`)}
            onHost={(presentationId) => navigate(`/host/${presentationId}`)}
            onExport={exportPresentation}
            onDelete={deletePresentation}
          />
        </div>
      )}
    </div>
  );
};

const Editor = ({ user }: { user: User }) => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [presentation, setPresentation] = useState<Presentation | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'error'>('saved');
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiSourceText, setAiSourceText] = useState('');
  const [aiMode, setAiMode] = useState<'presentation' | 'quiz'>('presentation');
  const [showAiModal, setShowAiModal] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addModalTab, setAddModalTab] = useState<'new' | 'existing' | 'import' | 'ai'>('new');
  const [otherPresentations, setOtherPresentations] = useState<Presentation[]>([]);
  const [selectedPresentationId, setSelectedPresentationId] = useState<string | null>(null);
  const [selectedPresentationSlides, setSelectedPresentationSlides] = useState<Slide[]>([]);

  const fetchOtherPresentations = async () => {
    const q = query(collection(db, 'presentations'), where('teacherId', '==', user.id));
    const snapshot = await getDocs(q);
    const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Presentation));
    setOtherPresentations(data.filter((p: any) => p.id !== id));
  };

  const fetchSlidesForPresentation = async (pId: string) => {
    const docRef = doc(db, 'presentations', pId);
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      setSelectedPresentationSlides(docSnap.data().slides);
    }
  };

  const importSlides = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const imported = JSON.parse(e.target?.result as string);
        const newSlides = Array.isArray(imported) ? imported : (imported.slides || []);
        if (presentation) {
          setPresentation({
            ...presentation,
            slides: [...presentation.slides, ...newSlides.map((s: any) => ({ ...s, id: nanoid(10) }))]
          });
        }
        setShowAddModal(false);
      } catch (err) {
        alert('Невалиден файл.');
      }
    };
    reader.readAsText(file);
  };

  const slideCategories = [
    {
      title: 'Нови познания',
      items: [
        { type: 'text-image', label: 'Статичен', icon: Monitor, color: 'bg-sky-400' },
        { type: 'video', label: 'Видео', icon: Video, color: 'bg-rose-400' },
      ]
    },
    {
      title: 'Проверка на знание',
      items: [
        { type: 'quiz-single', label: 'Тестови', icon: CheckSquare, color: 'bg-indigo-400' },
        { type: 'boolean', label: 'Вярно/Грешно', icon: ListChecks, color: 'bg-emerald-400' },
        { type: 'matching', label: 'Свързване', icon: LinkIcon, color: 'bg-amber-400' },
        { type: 'ordering', label: 'Подреждане', icon: Move, color: 'bg-cyan-500' },
        { type: 'categorization', label: 'Категоризиране', icon: Layout, color: 'bg-lime-500' },
        { type: 'hotspot', label: 'Посочване (Област)', icon: MapPin, color: 'bg-violet-400' },
        { type: 'labeling', label: 'Етикети', icon: Move, color: 'bg-teal-400' },
        { type: 'open-question', label: 'Отворен', icon: MessageSquare, color: 'bg-fuchsia-400' },
      ]
    },
    {
      title: 'Обратна връзка',
      items: [
        { type: 'whiteboard', label: 'Рисуване', icon: Palette, color: 'bg-orange-500' },
        { type: 'open-question', label: 'Въпрос със свободен отговор', icon: Type, color: 'bg-orange-400' },
      ]
    }
  ];

  const generateWithAI = async (mode: 'full' | 'single' = 'single') => {
    if (!aiPrompt.trim() && !aiSourceText.trim()) return;
    
    // Ensure we have the latest config
    if (!globalGeminiApiKey) {
      await fetchConfig();
    }

    let ai = getAIInstance();
    
    // If no key is found, try to open the selection dialog (AI Studio environment)
    if (!ai && (window as any).aistudio) {
      try {
        const hasKey = await (window as any).aistudio.hasSelectedApiKey();
        if (!hasKey) {
          await (window as any).aistudio.openSelectKey();
          // After opening, the key should be available in process.env.API_KEY
          ai = getAIInstance();
        }
      } catch (e) {
        console.error("Key selection failed:", e);
      }
    }

    if (!ai) {
      alert('Моля, конфигурирайте Gemini API ключ или изберете такъв чрез диалога за избор на ключ (горе вдясно или чрез настройките).');
      return;
    }

    setIsGenerating(true);
    try {
      const systemInstruction = mode === 'full' 
        ? `Вие сте експерт по образование. Генерирайте JSON масив от 5 до 8 интерактивни слайда на български език за цялостен урок.
          Налични типове: title, text-image, quiz-single, quiz-multi, open-question, boolean, hotspot, labeling, matching, ordering, categorization.
          Формат: [{ "type": "...", "content": { "title": "...", "body": "...", "options": [{ "text": "...", "isCorrect": boolean }], "imageUrl": "...", "hotspot": { "x": 50, "y": 50, "radius": 10 }, "labels": [{ "id": "...", "text": "...", "x": 50, "y": 50 }] } }]
          Важно: Създайте логическа последователност от информация и въпроси.`
        : `Вие сте експерт по образование. Генерирайте JSON масив от точно 1 интерактивен слайд на български език.
          Налични типове: title, text-image, quiz-single, quiz-multi, open-question, boolean, hotspot, labeling, matching, ordering, categorization.
          Формат: [{ "type": "...", "content": { "title": "...", "body": "...", "options": [{ "text": "...", "isCorrect": boolean }], "imageUrl": "...", "hotspot": { "x": 50, "y": 50, "radius": 10 }, "labels": [{ "id": "...", "text": "...", "x": 50, "y": 50 }] } }]
          Важно: Създайте съдържание, което точно отговаря на инструкцията.`;

      const userPrompt = mode === 'full'
        ? `Създай цялостен урок (5-8 слайда) въз основа на следното:
          Тема/Инструкция: ${aiPrompt}
          Изходен текст: ${aiSourceText}`
        : `Добави 1 нов слайд към презентацията въз основа на следното:
          Тема/Инструкция: ${aiPrompt}
          Изходен текст: ${aiSourceText}`;

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: userPrompt,
        config: { 
          systemInstruction,
          responseMimeType: "application/json" 
        }
      });

      if (!response.text) {
        throw new Error("Empty response from AI");
      }

      const generatedSlides = JSON.parse(response.text);
      if (presentation) {
        setPresentation({
          ...presentation,
          slides: [...presentation.slides, ...generatedSlides.map((s: any) => ({ ...s, id: nanoid(10) }))]
        });
      }
      setShowAiModal(false);
      setAiPrompt('');
      setAiSourceText('');
    } catch (error: any) {
      console.error("AI Generation failed:", error);
      
      const errorMsg = error.message || "";
      if (errorMsg.includes("Requested entity was not found") || errorMsg.includes("404") || errorMsg.includes("API_KEY_INVALID")) {
        if ((window as any).aistudio) {
          alert("Избраният API ключ е невалиден или няма достъп до модела. Моля, изберете нов ключ.");
          await (window as any).aistudio.openSelectKey();
        } else {
          alert("Грешка: Невалиден API ключ или моделът не е намерен. Проверете конфигурацията си.");
        }
      } else {
        alert(`Грешка при генерирането: ${error.message || "Моля опитайте пак."}`);
      }
    } finally {
      setIsGenerating(false);
    }
  };

  useEffect(() => {
    const fetchPresentation = async () => {
      try {
        const res = await fetch(`/api/presentations/${id}`, {
          headers: { 'teacher-id': user.id }
        });
        if (!res.ok) throw new Error('Failed to fetch');
        const data = await res.json();
        setPresentation(data);
      } catch (error) {
        console.error("Error fetching presentation:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchPresentation();
  }, [id, user.id]);

  const save = async () => {
    if (!presentation) return;
    setSaveStatus('saving');
    try {
      const res = await fetch(`/api/presentations/${id}`, {
        method: 'PUT',
        headers: { 
          'Content-Type': 'application/json',
          'teacher-id': user.id
        },
        body: JSON.stringify(presentation)
      });
      if (!res.ok) throw new Error('Save failed');
      setSaveStatus('saved');
    } catch (error) {
      console.error("Save failed:", error);
      setSaveStatus('error');
    }
  };

  // Auto-save effect
  useEffect(() => {
    if (!presentation) return;
    
    const timer = setTimeout(() => {
      save();
    }, 2000); // Auto-save after 2 seconds of inactivity

    return () => clearTimeout(timer);
  }, [presentation]);

  const addSlide = (type: SlideType) => {
    if (!presentation) return;
    const newSlide: Slide = {
      type,
      points: ['quiz-single', 'quiz-multi', 'boolean', 'labeling', 'hotspot', 'open-question', 'ordering', 'categorization'].includes(type) ? 1 : undefined,
      content: {
        title: type === 'title' ? 'Заглавие' : 'Нов Слайд',
        body: type === 'text-image' ? 'Въведете текст тук...' : '',
        options: (type === 'quiz-single' || type === 'quiz-multi') ? [
          { text: 'Опция 1', isCorrect: false },
          { text: 'Опция 2', isCorrect: false }
        ] : type === 'boolean' ? [
          { text: 'Вярно', isCorrect: true },
          { text: 'Грешно', isCorrect: false }
        ] : undefined,
        labels: type === 'labeling' ? [] : undefined,
        pairs: type === 'matching' ? [] : undefined,
        orderingItems: type === 'ordering' ? [
          { id: nanoid(), text: 'Първи елемент' },
          { id: nanoid(), text: 'Втори елемент' },
          { id: nanoid(), text: 'Трети елемент' }
        ] : undefined,
        categories: type === 'categorization' ? ['Категория 1', 'Категория 2'] : undefined,
        categoryItems: type === 'categorization' ? [
          { id: nanoid(), text: 'Елемент 1', category: 'Категория 1' },
          { id: nanoid(), text: 'Елемент 2', category: 'Категория 2' }
        ] : undefined,
        hotspot: type === 'hotspot' ? { x: 50, y: 50, radius: 10 } : undefined,
        imageUrl: (type === 'text-image' || type === 'labeling' || type === 'hotspot' || type === 'whiteboard') ? '' : undefined,
        videoUrl: type === 'video' ? '' : undefined,
      }
    };
    const newSlides = [...presentation.slides];
    newSlides.splice(activeSlideIndex + 1, 0, newSlide);
    setPresentation({ ...presentation, slides: newSlides });
    setActiveSlideIndex(activeSlideIndex + 1);
  };

  const updateSlide = (updates: Partial<Slide>) => {
    if (!presentation) return;
    const newSlides = [...presentation.slides];
    newSlides[activeSlideIndex] = { ...newSlides[activeSlideIndex], ...updates };
    setPresentation({ ...presentation, slides: newSlides });
  };

  const updateContent = (updates: any) => {
    if (!presentation) return;
    const slide = presentation.slides[activeSlideIndex];
    updateSlide({ content: { ...slide.content, ...updates } });
  };

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-12 h-12 animate-spin text-indigo-600" />
      </div>
    );
  }

  if (!presentation) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-gray-50 p-8 text-center">
        <XCircle className="w-16 h-16 text-rose-500 mb-4" />
        <h2 className="text-2xl font-bold mb-2">Урокът не е намерен</h2>
        <p className="text-gray-500 mb-6">Възможно е урокът да е бил изтрит или да нямате достъп до него.</p>
        <Button onClick={() => navigate('/')}>Обратно към таблото</Button>
      </div>
    );
  }

  const activeSlide = presentation.slides[activeSlideIndex];

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <header className="bg-white border-bottom border-gray-200 px-6 py-4 flex justify-between items-center">
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={() => navigate('/')}>
            <ChevronLeft className="w-5 h-5" /> Назад
          </Button>
          <input 
            className="text-xl font-bold bg-transparent border-none focus:ring-0 w-64"
            value={presentation.title || ''}
            onChange={e => setPresentation({ ...presentation, title: e.target.value })}
          />
        </div>
        <div className="flex gap-3 items-center">
          <div className="text-xs font-medium mr-4 flex items-center gap-2">
            {saveStatus === 'saving' && (
              <>
                <Loader2 className="w-3 h-3 animate-spin text-indigo-600" />
                <span className="text-gray-400">Запазване...</span>
              </>
            )}
            {saveStatus === 'saved' && (
              <>
                <div className="w-2 h-2 rounded-full bg-green-500" />
                <span className="text-gray-400">Всички промени са запазени</span>
              </>
            )}
            {saveStatus === 'error' && (
              <>
                <div className="w-2 h-2 rounded-full bg-red-500" />
                <span className="text-red-500">Грешка при запазване</span>
              </>
            )}
          </div>
          <Button 
            variant="secondary" 
            size="sm" 
            onClick={save}
            disabled={saveStatus === 'saving'}
            className="flex items-center gap-2"
          >
            <Save className="w-4 h-4" />
            Запази
          </Button>
          <Button variant="secondary" onClick={() => {
            setAiPrompt('');
            setAiSourceText('');
            setShowAiModal(true);
          }}>
            <Zap className="w-4 h-4" /> AI Асистент
          </Button>
          <Button variant="primary" onClick={() => navigate(`/host/${id}`)}>Пусни</Button>
        </div>
      </header>

      {/* AI Modal */}
      <AnimatePresence>
                {showAiModal && (
                  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
                    <motion.div 
                      initial={{ scale: 0.9, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      exit={{ scale: 0.9, opacity: 0 }}
                      className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-8"
                    >
                      <div className="flex justify-between items-center mb-6">
                        <div className="flex items-center gap-3">
                          <Zap className="w-6 h-6 text-indigo-600" />
                          <h3 className="text-2xl font-bold">Генерирай цял урок</h3>
                        </div>
                        <Button variant="ghost" onClick={() => setShowAiModal(false)}><X className="w-5 h-5" /></Button>
                      </div>
                      <p className="text-gray-500 mb-6">Въведете тема и AI ще създаде последователност от 5-8 слайда за вас.</p>
                      
                      <div className="space-y-4 mb-6">
                        <div>
                          <label className="block text-xs font-bold text-gray-400 uppercase mb-2 ml-1">Тема на урока</label>
                          <input 
                            type="text"
                            className="w-full p-4 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500"
                            placeholder="Напр. Слънчевата система за 4-ти клас..."
                            value={aiPrompt || ''}
                            onChange={e => setAiPrompt(e.target.value)}
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-gray-400 uppercase mb-2 ml-1">Изходен текст (по желание)</label>
                          <textarea 
                            className="w-full h-32 p-4 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500"
                            placeholder="Поставете текст от учебник..."
                            value={aiSourceText || ''}
                            onChange={e => setAiSourceText(e.target.value)}
                          />
                        </div>
                      </div>

                      <div className="flex gap-3">
                        <Button variant="secondary" className="flex-1" onClick={() => setShowAiModal(false)}>Отказ</Button>
                        <Button variant="primary" className="flex-1" onClick={() => generateWithAI('full')} loading={isGenerating}>
                          Генерирай
                        </Button>
                      </div>
                    </motion.div>
                  </div>
                )}
      </AnimatePresence>

      {/* Add Slide Modal */}
      <AnimatePresence>
        {showAddModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-3xl shadow-2xl w-full max-w-4xl overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="p-6 border-b border-gray-100 flex justify-between items-center">
                <div className="flex gap-8">
                  {[
                    { id: 'new', label: '+ ДОБАВИ ЕКРАН' },
                    { id: 'existing', label: 'ИЗПОЛЗВАЙ СЪЩЕСТВУВАЩ' },
                    { id: 'import', label: 'ИМПОРТИРАНЕ' },
                    { id: 'ai', label: 'ИЗКУСТВЕН ИНТЕЛЕКТ' }
                  ].map(tab => (
                    <button 
                      key={tab.id}
                      onClick={() => {
                        setAddModalTab(tab.id as any);
                        if (tab.id === 'existing') fetchOtherPresentations();
                      }}
                      className={`font-bold pb-2 transition-all ${addModalTab === tab.id ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-gray-400 hover:text-gray-600'}`}
                    >
                      {tab.id === 'ai' && <Zap className="inline w-4 h-4 mr-1" />}
                      {tab.label}
                    </button>
                  ))}
                </div>
                <Button variant="ghost" onClick={() => setShowAddModal(false)}><X className="w-6 h-6" /></Button>
              </div>

              <div className="p-8 overflow-y-auto flex-1">
                {addModalTab === 'new' && (
                  <div className="space-y-8">
                    {slideCategories.map((cat, i) => (
                      <div key={i}>
                        <h4 className="text-sm font-bold text-gray-500 mb-4">{cat.title}</h4>
                        <div className="grid grid-cols-2 gap-4">
                          {cat.items.map((item, j) => (
                            <button 
                              key={j}
                              onClick={() => {
                                addSlide(item.type as SlideType);
                                setShowAddModal(false);
                              }}
                              className="flex items-center gap-4 p-4 rounded-xl border border-gray-100 hover:border-indigo-200 hover:bg-indigo-50 transition-all text-left group"
                            >
                              <div className={`w-12 h-12 rounded-xl ${item.color} flex items-center justify-center text-white shadow-lg group-hover:scale-110 transition-transform`}>
                                <item.icon className="w-6 h-6" />
                              </div>
                              <span className="font-bold text-gray-700">{item.label}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {addModalTab === 'existing' && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8 h-full">
                    <div className="border-r border-gray-100 pr-8 overflow-y-auto">
                      <h4 className="text-sm font-bold text-gray-500 mb-4 uppercase">Изберете презентация</h4>
                      <div className="space-y-2">
                        {otherPresentations.map(p => (
                          <button 
                            key={p.id}
                            onClick={() => {
                              setSelectedPresentationId(p.id);
                              fetchSlidesForPresentation(p.id);
                            }}
                            className={`w-full text-left p-4 rounded-xl border transition-all ${selectedPresentationId === p.id ? 'border-indigo-600 bg-indigo-50 font-bold' : 'border-gray-100 hover:bg-gray-50'}`}
                          >
                            {p.title}
                          </button>
                        ))}
                        {otherPresentations.length === 0 && <p className="text-gray-400 italic">Няма други презентации.</p>}
                      </div>
                    </div>
                    <div className="overflow-y-auto">
                      <h4 className="text-sm font-bold text-gray-500 mb-4 uppercase">Изберете слайд</h4>
                      <div className="grid grid-cols-1 gap-4">
                        {selectedPresentationSlides.map((slide, idx) => (
                          <div 
                            key={idx}
                            onClick={() => {
                              if (presentation) {
                                setPresentation({
                                  ...presentation,
                                  slides: [...presentation.slides, { ...slide, id: nanoid(10) }]
                                });
                                setShowAddModal(false);
                              }
                            }}
                            className="aspect-video bg-gray-50 rounded-xl border-2 border-gray-100 p-4 cursor-pointer hover:border-indigo-600 transition-all"
                          >
                            <div className="text-[10px] font-black text-gray-300 uppercase mb-1">{slide.type}</div>
                            <div className="font-bold text-gray-700">{slide.content.title}</div>
                          </div>
                        ))}
                        {!selectedPresentationId && <p className="text-gray-400 italic">Изберете презентация отляво.</p>}
                      </div>
                    </div>
                  </div>
                )}

                {addModalTab === 'import' && (
                  <div className="flex flex-col items-center justify-center h-full py-12">
                    <div className="w-20 h-20 bg-indigo-50 rounded-full flex items-center justify-center text-indigo-600 mb-6">
                      <Download className="w-10 h-10" />
                    </div>
                    <h3 className="text-2xl font-bold mb-2">Импортиране на слайдове</h3>
                    <p className="text-gray-500 mb-8 text-center max-w-md">Качете JSON файл с презентация или слайдове, за да ги добавите към текущия урок.</p>
                    <label className="cursor-pointer">
                      <div className="px-5 py-2.5 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 bg-indigo-500 text-white hover:bg-indigo-600 shadow-lg shadow-indigo-100 active:scale-95">
                        Избери файл
                      </div>
                      <input type="file" className="hidden" accept=".json" onChange={importSlides} />
                    </label>
                  </div>
                )}

                {addModalTab === 'ai' && (
                  <div className="max-w-2xl mx-auto py-8">
                    <div className="flex items-center gap-4 mb-8">
                      <div className="w-16 h-16 bg-indigo-600 rounded-2xl flex items-center justify-center text-white shadow-xl">
                        <Zap className="w-8 h-8" />
                      </div>
                      <div>
                        <h3 className="text-2xl font-bold">Добави слайдове с AI</h3>
                        <p className="text-gray-500 text-sm">Опишете темата или поставете текст, за да генерирате нови слайдове към този урок.</p>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-bold text-gray-400 uppercase mb-2 ml-1">Какъв слайд искате?</label>
                        <input 
                          type="text"
                          className="w-full p-4 border-2 border-gray-100 rounded-xl focus:border-indigo-500 focus:ring-0 text-lg"
                          placeholder="Напр. Обясни фотосинтезата, Създай въпрос за..."
                          value={aiPrompt || ''}
                          onChange={e => setAiPrompt(e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-gray-400 uppercase mb-2 ml-1">Изходен текст (по желание)</label>
                        <textarea 
                          className="w-full h-48 p-4 border-2 border-gray-100 rounded-xl focus:border-indigo-500 focus:ring-0 text-base"
                          placeholder="Поставете тук текста, от който искате да се генерира слайда..."
                          value={aiSourceText || ''}
                          onChange={e => setAiSourceText(e.target.value)}
                        />
                      </div>
                    </div>

                    <Button 
                      variant="primary" 
                      className="w-full h-16 text-xl shadow-xl shadow-indigo-100 mt-8" 
                      onClick={() => generateWithAI('single')} 
                      loading={isGenerating}
                    >
                      Генерирай 1 слайд
                    </Button>
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <div className="w-72 bg-slate-50 border-r border-slate-200 flex flex-col">
          <div className="p-6">
            <Button variant="primary" className="w-full py-4 rounded-2xl shadow-xl shadow-indigo-100" onClick={() => setShowAddModal(true)}>
              <Plus className="w-5 h-5" /> Добави екран
            </Button>
          </div>
          
          <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-4">
            {presentation.slides.map((slide, idx) => (
              <div key={idx} className="group relative">
                <motion.div 
                  whileHover={{ scale: 1.02 }}
                  onClick={() => setActiveSlideIndex(idx)}
                  className={`relative aspect-video rounded-2xl border-2 cursor-pointer overflow-hidden transition-all ${activeSlideIndex === idx ? 'border-indigo-500 ring-4 ring-indigo-50 shadow-lg' : 'border-white bg-white hover:border-indigo-200'}`}
                >
                  <div className="absolute top-2 left-2 z-10 w-6 h-6 bg-white/90 backdrop-blur rounded-lg flex items-center justify-center text-[10px] font-black shadow-sm text-indigo-600">
                    {idx + 1}
                  </div>
                  <div 
                    className="w-full h-full flex flex-col p-3"
                    style={{ backgroundColor: slide.content.backgroundColor || '#ffffff' }}
                  >
                    <div className="text-[8px] font-black text-indigo-200 uppercase mb-1 tracking-wider">{slide.type}</div>
                    <div className="text-[10px] font-bold text-slate-600 line-clamp-2 leading-tight">
                      {slide.content.title || 'Без заглавие'}
                    </div>
                    <div className="mt-auto flex justify-end opacity-20 text-indigo-400">
                      {slide.type === 'text-image' && <ImageIcon className="w-4 h-4" />}
                      {slide.type === 'quiz-single' && <CheckSquare className="w-4 h-4" />}
                      {slide.type === 'whiteboard' && <Palette className="w-4 h-4" />}
                    </div>
                  </div>
                </motion.div>
                
                {/* Reorder Controls */}
                <div className="absolute -right-2 top-1/2 -translate-y-1/2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                  <button 
                    disabled={idx === 0}
                    onClick={(e) => {
                      e.stopPropagation();
                      const newSlides = [...presentation.slides];
                      [newSlides[idx], newSlides[idx - 1]] = [newSlides[idx - 1], newSlides[idx]];
                      setPresentation({ ...presentation, slides: newSlides });
                      setActiveSlideIndex(idx - 1);
                    }}
                    className="p-1 bg-white rounded-full shadow-md border border-gray-100 text-gray-400 hover:text-indigo-600 disabled:opacity-30"
                  >
                    <ChevronLeft className="w-3 h-3 rotate-90" />
                  </button>
                  <button 
                    disabled={idx === presentation.slides.length - 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      const newSlides = [...presentation.slides];
                      [newSlides[idx], newSlides[idx + 1]] = [newSlides[idx + 1], newSlides[idx]];
                      setPresentation({ ...presentation, slides: newSlides });
                      setActiveSlideIndex(idx + 1);
                    }}
                    className="p-1 bg-white rounded-full shadow-md border border-gray-100 text-gray-400 hover:text-indigo-600 disabled:opacity-30"
                  >
                    <ChevronLeft className="w-3 h-3 -rotate-90" />
                  </button>
                </div>
              </div>
            ))}
          </div>
          
          <div className="p-4 border-t border-gray-100">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3">Оформление</p>
            <div className="space-y-4">
              <div>
                <label className="text-[10px] font-bold text-gray-400 uppercase block mb-2">Общ Фон (URL)</label>
                <input 
                  className="w-full p-2 text-xs border border-gray-200 rounded-lg focus:ring-2 focus:ring-indigo-500"
                  placeholder="https://..."
                  value={presentation.globalBackgroundImage || ''}
                  onChange={e => setPresentation({ ...presentation, globalBackgroundImage: e.target.value })}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Main Editor Area */}
        <main className="flex-1 p-12 overflow-y-auto relative bg-slate-100/50">
          {presentation.globalBackgroundImage && (
            <div 
              className="absolute inset-0 opacity-10 pointer-events-none"
              style={{ backgroundImage: `url(${presentation.globalBackgroundImage})`, backgroundSize: 'cover' }}
            />
          )}
          {activeSlide ? (
            <div className="max-w-3xl mx-auto relative z-10">
              <Card 
                className="min-h-[400px] flex flex-col p-12 overflow-hidden transition-colors border-white shadow-2xl shadow-slate-200/50 relative"
                style={{ backgroundColor: activeSlide.content.backgroundColor || '#ffffff' }}
              >
                {presentation.globalBackgroundImage && (
                  <div 
                    className="absolute inset-0 opacity-10 pointer-events-none"
                    style={{ backgroundImage: `url(${presentation.globalBackgroundImage})`, backgroundSize: 'cover' }}
                  />
                )}
                <div className="flex justify-between items-start mb-8 relative z-10">
                  <div className="flex-1 mr-8">
                    <div className="flex justify-between items-center mb-2">
                      <label className="text-[10px] font-bold text-gray-400 uppercase">Заглавие</label>
                      <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-gray-400">Цвят:</span>
                          <input 
                            type="color" 
                            className="w-6 h-6 rounded border-none p-0 bg-transparent cursor-pointer"
                            value={activeSlide.content.titleColor || '#000000'}
                            onChange={e => updateContent({ titleColor: e.target.value })}
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-gray-400">Размер:</span>
                          <input 
                            type="range" min="20" max="100" className="w-20 h-1 accent-indigo-600"
                            value={activeSlide.content.titleSize || 40}
                            onChange={e => updateContent({ titleSize: parseInt(e.target.value) })}
                          />
                        </div>
                        <div className="flex items-center gap-2 border-l border-gray-100 pl-4">
                          <span className="text-[10px] text-gray-400">Фон:</span>
                          <input 
                            type="color" 
                            className="w-6 h-6 rounded border-none p-0 bg-transparent cursor-pointer"
                            value={activeSlide.content.backgroundColor || '#ffffff'}
                            onChange={e => updateContent({ backgroundColor: e.target.value })}
                          />
                        </div>
                      </div>
                    </div>
                    <input 
                      className="font-bold w-full border-none focus:ring-0 p-0 leading-tight bg-transparent"
                      style={{ 
                        fontSize: `${activeSlide.content.titleSize || 40}px`,
                        color: activeSlide.content.titleColor || '#000000'
                      }}
                      placeholder="Заглавие на слайда"
                      value={activeSlide.content.title || ''}
                      onChange={e => updateContent({ title: e.target.value })}
                    />
                  </div>
                  {activeSlide.points !== undefined && (
                    <div className="bg-indigo-50 p-4 rounded-2xl border border-indigo-100 flex flex-col items-center">
                      <label className="text-[10px] font-bold text-indigo-400 uppercase mb-1">Точки</label>
                      <input 
                        type="number"
                        className="w-16 text-center text-xl font-black text-indigo-600 bg-transparent border-none focus:ring-0"
                        value={activeSlide.points || 0}
                        onChange={e => {
                          const newSlides = [...presentation.slides];
                          newSlides[activeSlideIndex] = { ...activeSlide, points: parseInt(e.target.value) || 0 };
                          setPresentation({ ...presentation, slides: newSlides });
                        }}
                      />
                    </div>
                  )}
                </div>
                
                {activeSlide.type === 'title' && (
                  <div className="flex-1 flex items-center justify-center">
                    <p className="text-gray-400 italic">Този слайд съдържа само голямо заглавие.</p>
                  </div>
                )}

                {activeSlide.type === 'text-image' && (
                  <div className="flex flex-col gap-6">
                    <div className="p-4 bg-indigo-50 rounded-2xl border border-indigo-100">
                      <label className="text-[10px] font-bold text-indigo-400 uppercase block mb-3">Оформление на екрана</label>
                      <div className="grid grid-cols-5 gap-2">
                        {[
                          { id: 'left', label: 'Ляво', icon: ChevronLeft },
                          { id: 'right', label: 'Дясно', icon: ChevronRight },
                          { id: 'top', label: 'Горе', icon: ChevronUp },
                          { id: 'bottom', label: 'Долу', icon: ChevronDown },
                          { id: 'full', label: 'Текст', icon: Type }
                        ].map(l => (
                          <button 
                            key={l.id}
                            onClick={() => updateContent({ layout: l.id })}
                            className={`flex flex-col items-center gap-1 p-2 rounded-lg border-2 transition-all ${activeSlide.content.layout === l.id ? 'border-indigo-600 bg-white shadow-sm' : 'border-transparent hover:bg-white/50'}`}
                          >
                            <l.icon className="w-4 h-4 text-indigo-600" />
                            <span className="text-[8px] font-bold uppercase">{l.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between items-center mb-2">
                        <label className="text-[10px] font-bold text-gray-400 uppercase">Текст</label>
                        <div className="flex items-center gap-4">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-gray-400">Цвят:</span>
                            <input 
                              type="color" 
                              className="w-6 h-6 rounded border-none p-0 bg-transparent cursor-pointer"
                              value={activeSlide.content.bodyColor || '#4b5563'}
                              onChange={e => updateContent({ bodyColor: e.target.value })}
                            />
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-gray-400">Размер:</span>
                            <input 
                              type="range" min="12" max="48" className="w-20 h-1 accent-indigo-600"
                              value={activeSlide.content.bodySize || 20}
                              onChange={e => updateContent({ bodySize: parseInt(e.target.value) })}
                            />
                          </div>
                        </div>
                      </div>
                      <textarea 
                        className="w-full border-none focus:ring-0 p-0 resize-none bg-transparent"
                        style={{ 
                          fontSize: `${activeSlide.content.bodySize || 20}px`,
                          color: activeSlide.content.bodyColor || '#4b5563'
                        }}
                        placeholder="Вашият текст тук..."
                        value={activeSlide.content.body || ''}
                        onChange={e => updateContent({ body: e.target.value })}
                      />
                    </div>
                    {activeSlide.content.layout !== 'full' && (
                      <div className="p-4 bg-gray-50 rounded-xl border border-dashed border-gray-300">
                        <div className="flex justify-between items-center mb-2">
                          <label className="text-xs font-bold text-gray-500">Снимка</label>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-gray-400">Мащаб:</span>
                            <input 
                              type="range" min="10" max="100" className="w-20 h-1 accent-indigo-600"
                              value={activeSlide.content.imageScale || 100}
                              onChange={e => updateContent({ imageScale: parseInt(e.target.value) })}
                            />
                          </div>
                        </div>
                        <input 
                          className="w-full p-2 border border-gray-200 rounded-lg text-xs"
                          placeholder="URL на снимка"
                          value={activeSlide.content.imageUrl || ''}
                          onChange={e => updateContent({ imageUrl: e.target.value })}
                        />
                        {activeSlide.content.imageUrl && (
                          <div className="mt-4 flex justify-center">
                            <img 
                              src={activeSlide.content.imageUrl} 
                              style={{ width: `${activeSlide.content.imageScale || 100}%` }}
                              className="object-contain rounded-lg" 
                              alt="Preview" 
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {activeSlide.type === 'video' && (
                  <div className="flex flex-col gap-6">
                    <div className="p-4 bg-gray-50 rounded-xl border border-dashed border-gray-300">
                      <label className="block text-xs font-bold text-gray-500 mb-2">URL на видео (YouTube/MP4)</label>
                      <input 
                        className="w-full p-2 border border-gray-200 rounded-lg"
                        placeholder="https://www.youtube.com/watch?v=..."
                        value={activeSlide.content.videoUrl || ''}
                        onChange={e => updateContent({ videoUrl: e.target.value })}
                      />
                    </div>
                    {activeSlide.content.videoUrl && (
                      <div className="w-full aspect-video rounded-xl overflow-hidden shadow-lg bg-black">
                        {activeSlide.content.videoUrl.includes('youtube.com') || activeSlide.content.videoUrl.includes('youtu.be') ? (
                          <iframe 
                            className="w-full h-full"
                            src={getYouTubeEmbedUrl(activeSlide.content.videoUrl)}
                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                            allowFullScreen
                          />
                        ) : (
                          <video src={activeSlide.content.videoUrl} controls className="w-full h-full" />
                        )}
                      </div>
                    )}
                  </div>
                )}

                {(activeSlide.type === 'quiz-single' || activeSlide.type === 'quiz-multi') && (
                  <div className="flex flex-col gap-4">
                    {activeSlide.content.options?.map((opt, idx) => (
                      <div key={idx} className="flex gap-2 items-center">
                        <button 
                          onClick={() => {
                            const newOpts = [...(activeSlide.content.options || [])];
                            if (activeSlide.type === 'quiz-single') {
                              newOpts.forEach((o, i) => o.isCorrect = i === idx);
                            } else {
                              newOpts[idx].isCorrect = !newOpts[idx].isCorrect;
                            }
                            updateContent({ options: newOpts });
                          }}
                          className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs transition-colors ${opt.isCorrect ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-400'}`}
                        >
                          {opt.isCorrect ? <CheckCircle2 className="w-4 h-4" /> : String.fromCharCode(65 + idx)}
                        </button>
                        <input 
                          className="flex-1 p-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-indigo-500"
                          value={opt.text || ''}
                          onChange={e => {
                            const newOpts = [...(activeSlide.content.options || [])];
                            newOpts[idx].text = e.target.value;
                            updateContent({ options: newOpts });
                          }}
                        />
                        <Button variant="ghost" onClick={() => {
                          const newOpts = activeSlide.content.options?.filter((_, i) => i !== idx);
                          updateContent({ options: newOpts });
                        }}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    ))}
                    <Button variant="secondary" onClick={() => updateContent({ options: [...(activeSlide.content.options || []), { text: 'Нова опция', isCorrect: false }] })}>
                      + Добави опция
                    </Button>
                  </div>
                )}

                {activeSlide.type === 'boolean' && (
                  <div className="flex flex-col gap-6">
                    <div className="grid grid-cols-2 gap-4">
                      {activeSlide.content.options?.map((opt, i) => (
                        <button 
                          key={i} 
                          onClick={() => {
                            const newOpts = activeSlide.content.options?.map((o, idx) => ({
                              ...o,
                              isCorrect: idx === i
                            }));
                            updateContent({ options: newOpts });
                          }}
                          className={`p-8 rounded-3xl border-4 transition-all flex flex-col items-center gap-4 ${opt.isCorrect ? 'border-green-500 bg-green-50' : 'border-gray-100 hover:border-gray-200'}`}
                        >
                          <div className={`w-12 h-12 rounded-full flex items-center justify-center ${opt.isCorrect ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-400'}`}>
                            <CheckCircle2 className="w-6 h-6" />
                          </div>
                          <span className="text-xl font-black">{opt.text}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {activeSlide.type === 'hotspot' && (
                  <div className="flex flex-col gap-6">
                    <div className="p-4 bg-gray-50 rounded-xl border border-dashed border-gray-300">
                      <label className="text-xs font-bold text-gray-500 block mb-2">Изображение за посочване</label>
                      <input 
                        className="w-full p-2 border border-gray-200 rounded-lg text-xs"
                        placeholder="URL на снимка"
                        value={activeSlide.content.imageUrl || ''}
                        onChange={e => updateContent({ imageUrl: e.target.value })}
                      />
                    </div>
                    {activeSlide.content.imageUrl && (
                      <div className="relative aspect-video bg-black rounded-2xl overflow-hidden group">
                        <img src={activeSlide.content.imageUrl} className="w-full h-full object-contain opacity-80" alt="Hotspot" />
                        <div 
                          className="absolute border-4 border-indigo-500 bg-indigo-500/30 rounded-full cursor-move shadow-[0_0_20px_rgba(99,102,241,0.5)]"
                          style={{
                            left: `${activeSlide.content.hotspot?.x || 50}%`,
                            top: `${activeSlide.content.hotspot?.y || 50}%`,
                            width: `${(activeSlide.content.hotspot?.radius || 10) * 2}%`,
                            height: `${(activeSlide.content.hotspot?.radius || 10) * 2}%`,
                            transform: 'translate(-50%, -50%)'
                          }}
                          onMouseDown={(e) => {
                            const rect = e.currentTarget.parentElement?.getBoundingClientRect();
                            if (!rect) return;
                            const onMouseMove = (moveEvent: MouseEvent) => {
                              const x = Math.max(0, Math.min(100, ((moveEvent.clientX - rect.left) / rect.width) * 100));
                              const y = Math.max(0, Math.min(100, ((moveEvent.clientY - rect.top) / rect.height) * 100));
                              updateContent({ hotspot: { ...activeSlide.content.hotspot!, x, y } });
                            };
                            const onMouseUp = () => {
                              window.removeEventListener('mousemove', onMouseMove);
                              window.removeEventListener('mouseup', onMouseUp);
                            };
                            window.addEventListener('mousemove', onMouseMove);
                            window.addEventListener('mouseup', onMouseUp);
                          }}
                        >
                          {/* Resize Handle */}
                          <div 
                            className="absolute bottom-0 right-0 w-6 h-6 bg-white rounded-full border-2 border-indigo-500 cursor-nwse-resize flex items-center justify-center shadow-lg"
                            style={{ transform: 'translate(30%, 30%)' }}
                            onMouseDown={(e) => {
                              e.stopPropagation();
                              const rect = e.currentTarget.parentElement?.parentElement?.getBoundingClientRect();
                              if (!rect) return;
                              const startX = activeSlide.content.hotspot?.x || 50;
                              const startY = activeSlide.content.hotspot?.y || 50;
                              const onMouseMove = (moveEvent: MouseEvent) => {
                                const currentX = ((moveEvent.clientX - rect.left) / rect.width) * 100;
                                const currentY = ((moveEvent.clientY - rect.top) / rect.height) * 100;
                                const dist = Math.sqrt(Math.pow(currentX - startX, 2) + Math.pow(currentY - startY, 2));
                                updateContent({ hotspot: { ...activeSlide.content.hotspot!, radius: Math.max(2, Math.min(40, dist)) } });
                              };
                              const onMouseUp = () => {
                                window.removeEventListener('mousemove', onMouseMove);
                                window.removeEventListener('mouseup', onMouseUp);
                              };
                              window.addEventListener('mousemove', onMouseMove);
                              window.addEventListener('mouseup', onMouseUp);
                            }}
                          >
                            <div className="w-1 h-1 bg-indigo-500 rounded-full" />
                          </div>
                        </div>
                        <div className="absolute bottom-4 left-4 right-4 bg-black/60 backdrop-blur p-3 rounded-xl text-white text-xs flex justify-between items-center opacity-0 group-hover:opacity-100 transition-opacity">
                          <span>Влачете кръга, за да определите вярната област</span>
                          <div className="flex items-center gap-2">
                            <span>Размер:</span>
                            <input 
                              type="range" min="2" max="30" 
                              value={activeSlide.content.hotspot?.radius || 10}
                              onChange={e => updateContent({ hotspot: { ...activeSlide.content.hotspot!, radius: parseInt(e.target.value) } })}
                              className="w-24 accent-indigo-500"
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {activeSlide.type === 'open-question' && (
                  <div className="flex flex-col gap-4">
                    <p className="text-gray-400 italic">Учениците ще могат да пишат свободен текст като отговор.</p>
                    <input 
                      className="w-full p-3 border border-gray-200 rounded-xl"
                      placeholder="Подсказка (Placeholder)..."
                      value={activeSlide.content.placeholder || ''}
                      onChange={e => updateContent({ placeholder: e.target.value })}
                    />
                  </div>
                )}

                {activeSlide.type === 'labeling' && (
                  <div className="flex flex-col gap-6">
                    <div className="p-4 bg-gray-50 rounded-xl border border-dashed border-gray-300">
                      <label className="block text-xs font-bold text-gray-500 mb-2">URL на фоново изображение</label>
                      <input 
                        className="w-full p-2 border border-gray-200 rounded-lg"
                        placeholder="https://example.com/diagram.jpg"
                        value={activeSlide.content.imageUrl || ''}
                        onChange={e => updateContent({ imageUrl: e.target.value })}
                      />
                    </div>
                    <div className="space-y-3">
                      <label className="block text-xs font-bold text-gray-500 uppercase">Етикети и Зони за поставяне</label>
                      <p className="text-xs text-gray-400 mb-2">Поставете етикетите върху изображението. Тези позиции ще станат "зони за поставяне" за учениците.</p>
                      <p className="text-[11px] text-indigo-500 mb-2">Напасване към мрежа: 2% (по-лесно позициониране)</p>
                      <div className="relative aspect-video bg-gray-100 rounded-xl overflow-hidden border border-gray-200 mb-4">
                        {activeSlide.content.imageUrl && (
                          <img src={activeSlide.content.imageUrl} className="absolute inset-0 w-full h-full object-cover opacity-50" alt="BG" />
                        )}
                        <div className="absolute inset-0" id="label-editor-container">
                          {activeSlide.content.labels?.map((label, idx) => (
                            <motion.div
                              key={label.id}
                              drag
                              dragMomentum={false}
                              onDragEnd={(_, info) => {
                                const container = document.getElementById('label-editor-container');
                                if (container) {
                                  const rect = container.getBoundingClientRect();
                                  const rawX = Math.max(0, Math.min(100, ((info.point.x - rect.left) / rect.width) * 100));
                                  const rawY = Math.max(0, Math.min(100, ((info.point.y - rect.top) / rect.height) * 100));
                                  const snap = (value: number, step = 2) => Math.round(value / step) * step;
                                  const x = snap(rawX);
                                  const y = snap(rawY);
                                  const newLabels = [...(activeSlide.content.labels || [])];
                                  newLabels[idx] = { ...newLabels[idx], x, y };
                                  updateContent({ labels: newLabels });
                                }
                              }}
                              className="absolute cursor-move bg-white px-3 py-1 rounded shadow-md border-2 border-indigo-500 text-xs font-bold text-indigo-600 min-w-[80px] text-center"
                              style={{ left: `${label.x}%`, top: `${label.y}%`, transform: 'translate(-50%, -50%)' }}
                            >
                              {label.text}
                            </motion.div>
                          ))}
                        </div>
                      </div>
                      {activeSlide.content.labels?.map((label, idx) => (
                        <div key={label.id} className="flex gap-2">
                          <input 
                            className="flex-1 p-2 border border-gray-200 rounded-lg"
                            value={label.text || ''}
                            onChange={e => {
                              const newLabels = [...(activeSlide.content.labels || [])];
                              newLabels[idx].text = e.target.value;
                              updateContent({ labels: newLabels });
                            }}
                          />
                          <Button variant="ghost" onClick={() => {
                            const newLabels = activeSlide.content.labels?.filter((_, i) => i !== idx);
                            updateContent({ labels: newLabels });
                          }}>
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      ))}
                      <Button variant="secondary" onClick={() => updateContent({ 
                        labels: [...(activeSlide.content.labels || []), { id: nanoid(5), text: 'Нов етикет', x: 50, y: 50 }] 
                      })}>
                        + Добави етикет
                      </Button>
                    </div>
                  </div>
                )}

                {activeSlide.type === 'matching' && (
                  <div className="flex flex-col gap-6">
                    <div className="space-y-4">
                      <label className="block text-xs font-bold text-gray-500 uppercase">Двойки за свързване</label>
                      <p className="text-xs text-gray-400">Добавете двойки от елементи. Учениците ще трябва да ги свържат правилно.</p>
                      
                      <div className="space-y-3">
                        {activeSlide.content.pairs?.map((pair, idx) => (
                          <div key={pair.id} className="flex gap-3 items-center bg-gray-50 p-3 rounded-xl border border-gray-100">
                            <div className="flex-1 space-y-2">
                              <input 
                                className="w-full p-2 border border-gray-200 rounded-lg text-sm"
                                placeholder="Ляв елемент"
                                value={pair.left || ''}
                                onChange={e => {
                                  const newPairs = [...(activeSlide.content.pairs || [])];
                                  newPairs[idx].left = e.target.value;
                                  updateContent({ pairs: newPairs });
                                }}
                              />
                              <input 
                                className="w-full p-2 border border-gray-200 rounded-lg text-sm"
                                placeholder="Десен елемент"
                                value={pair.right || ''}
                                onChange={e => {
                                  const newPairs = [...(activeSlide.content.pairs || [])];
                                  newPairs[idx].right = e.target.value;
                                  updateContent({ pairs: newPairs });
                                }}
                              />
                            </div>
                            <Button variant="ghost" className="text-red-500" onClick={() => {
                              const newPairs = activeSlide.content.pairs?.filter((_, i) => i !== idx);
                              updateContent({ pairs: newPairs });
                            }}>
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                      
                      <Button variant="secondary" className="w-full" onClick={() => {
                        const newPairs = [...(activeSlide.content.pairs || []), { id: nanoid(), left: '', right: '' }];
                        updateContent({ pairs: newPairs });
                      }}>
                        + Добави двойка
                      </Button>
                    </div>
                  </div>
                )}

                {activeSlide.type === 'ordering' && (
                  <div className="flex flex-col gap-4">
                    <label className="block text-xs font-bold text-gray-500 uppercase">Елементи за подреждане (правилен ред)</label>
                    <p className="text-xs text-gray-400">Учениците ще трябва да подредят елементите в точно този ред.</p>
                    <div className="space-y-2">
                      {(activeSlide.content.orderingItems || []).map((item, idx) => (
                        <div key={item.id} className="flex items-center gap-2 bg-gray-50 p-2 rounded-xl border border-gray-100">
                          <span className="text-xs font-black text-gray-400 w-6 text-center">{idx + 1}</span>
                          <input
                            className="flex-1 p-2 border border-gray-200 rounded-lg text-sm"
                            value={item.text}
                            onChange={e => {
                              const next = [...(activeSlide.content.orderingItems || [])];
                              next[idx] = { ...next[idx], text: e.target.value };
                              updateContent({ orderingItems: next });
                            }}
                          />
                          <Button variant="ghost" onClick={() => {
                            const next = (activeSlide.content.orderingItems || []).filter((_, i) => i !== idx);
                            updateContent({ orderingItems: next });
                          }}><Trash2 className="w-4 h-4" /></Button>
                        </div>
                      ))}
                    </div>
                    <Button variant="secondary" onClick={() => {
                      const next = [...(activeSlide.content.orderingItems || []), { id: nanoid(), text: 'Нов елемент' }];
                      updateContent({ orderingItems: next });
                    }}>+ Добави елемент</Button>
                  </div>
                )}

                {activeSlide.type === 'categorization' && (
                  <div className="flex flex-col gap-5">
                    <label className="block text-xs font-bold text-gray-500 uppercase">Категории и елементи</label>
                    <div className="space-y-2">
                      <p className="text-xs text-gray-400">Категории</p>
                      {(activeSlide.content.categories || []).map((cat, idx) => (
                        <div key={idx} className="flex gap-2">
                          <input className="flex-1 p-2 border border-gray-200 rounded-lg text-sm" value={cat}
                            onChange={e => {
                              const next = [...(activeSlide.content.categories || [])];
                              const oldCat = next[idx];
                              next[idx] = e.target.value;
                              const items = (activeSlide.content.categoryItems || []).map(it => it.category === oldCat ? { ...it, category: e.target.value } : it);
                              updateContent({ categories: next, categoryItems: items });
                            }}
                          />
                          <Button variant="ghost" onClick={() => {
                            const removeCat = (activeSlide.content.categories || [])[idx];
                            const cats = (activeSlide.content.categories || []).filter((_, i) => i !== idx);
                            const items = (activeSlide.content.categoryItems || []).filter(it => it.category !== removeCat);
                            updateContent({ categories: cats, categoryItems: items });
                          }}><Trash2 className="w-4 h-4" /></Button>
                        </div>
                      ))}
                      <Button variant="secondary" onClick={() => updateContent({ categories: [...(activeSlide.content.categories || []), `Категория ${(activeSlide.content.categories || []).length + 1}`] })}>+ Добави категория</Button>
                    </div>
                    <div className="space-y-2">
                      <p className="text-xs text-gray-400">Елементи и правилна категория</p>
                      {(activeSlide.content.categoryItems || []).map((item, idx) => (
                        <div key={item.id} className="grid grid-cols-12 gap-2">
                          <input className="col-span-7 p-2 border border-gray-200 rounded-lg text-sm" value={item.text}
                            onChange={e => {
                              const next = [...(activeSlide.content.categoryItems || [])];
                              next[idx] = { ...next[idx], text: e.target.value };
                              updateContent({ categoryItems: next });
                            }}
                          />
                          <select className="col-span-4 p-2 border border-gray-200 rounded-lg text-sm" value={item.category}
                            onChange={e => {
                              const next = [...(activeSlide.content.categoryItems || [])];
                              next[idx] = { ...next[idx], category: e.target.value };
                              updateContent({ categoryItems: next });
                            }}>
                            {(activeSlide.content.categories || []).map(cat => <option key={cat} value={cat}>{cat}</option>)}
                          </select>
                          <Button variant="ghost" className="col-span-1" onClick={() => {
                            const next = (activeSlide.content.categoryItems || []).filter((_, i) => i !== idx);
                            updateContent({ categoryItems: next });
                          }}><Trash2 className="w-4 h-4" /></Button>
                        </div>
                      ))}
                      <Button variant="secondary" onClick={() => {
                        const fallback = (activeSlide.content.categories || [])[0] || 'Категория 1';
                        const next = [...(activeSlide.content.categoryItems || []), { id: nanoid(), text: 'Нов елемент', category: fallback }];
                        updateContent({ categoryItems: next });
                      }}>+ Добави елемент</Button>
                    </div>
                  </div>
                )}

                {/* Timer Settings */}
                {['quiz-single', 'quiz-multi', 'open-question', 'labeling', 'whiteboard', 'boolean', 'hotspot', 'matching', 'ordering', 'categorization'].includes(activeSlide.type) && (
                  <div className="mt-12 pt-8 border-t border-gray-100">
                    <label className="block text-xs font-bold text-gray-400 uppercase mb-4">Настройки на времето</label>
                    <div className="flex items-center gap-4">
                      <input 
                        type="range" 
                        min="0" 
                        max="120" 
                        step="5"
                        className="flex-1 accent-indigo-600"
                        value={activeSlide.duration || 0}
                        onChange={e => updateSlide({ duration: parseInt(e.target.value) })}
                      />
                      <span className="w-20 text-center font-bold text-indigo-600">
                        {activeSlide.duration ? `${activeSlide.duration} сек` : 'Без лимит'}
                      </span>
                    </div>
                  </div>
                )}
              </Card>
              <div className="mt-8 flex justify-end">
                <Button variant="danger" onClick={() => {
                  const newSlides = presentation.slides.filter((_, i) => i !== activeSlideIndex);
                  setPresentation({ ...presentation, slides: newSlides });
                  setActiveSlideIndex(Math.max(0, activeSlideIndex - 1));
                }}>
                  Изтрий Слайд
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-gray-400">
              <Layout className="w-16 h-16 mb-4 opacity-20" />
              <p>Изберете или добавете слайд, за да започнете.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

const HostView = ({ user }: { user: User }) => {
  const { id } = useParams();
  const [pin, setPin] = useState<string | null>(null);
  const [students, setStudents] = useState<any[]>([]);
  const [currentSlide, setCurrentSlide] = useState<any>(null);
  const [responses, setResponses] = useState<Record<string, any>>({});
  const [leaderboard, setLeaderboard] = useState<any[]>([]);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [isFinished, setIsFinished] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [hostPrivacyMode, setHostPrivacyMode] = useState(false);
  const [isSavingReport, setIsSavingReport] = useState(false);
  const [isDownloadingReport, setIsDownloadingReport] = useState(false);
  const [isReportSaved, setIsReportSaved] = useState(false);
  const [hostOrderingPreview, setHostOrderingPreview] = useState<{ id: string; text: string }[]>([]);
  const timerRef = useRef<any>(null);
  const ws = useRef<WebSocket | null>(null);
  const navigate = useNavigate();

  const [presentationData, setPresentationData] = useState<Presentation | null>(null);
  const latestPresentationRef = useRef<Presentation | null>(null);
  const latestTeacherIdRef = useRef(user.id);
  const latestPrivacyModeRef = useRef(false);
  const latestPinRef = useRef<string | null>(null);

  useEffect(() => {
    latestPresentationRef.current = presentationData;
  }, [presentationData]);

  useEffect(() => {
    latestTeacherIdRef.current = user.id;
  }, [user.id]);

  useEffect(() => {
    latestPrivacyModeRef.current = hostPrivacyMode;
  }, [hostPrivacyMode]);

  useEffect(() => {
    latestPinRef.current = pin;
  }, [pin]);
  useEffect(() => {
    if (id) {
      // Fetch from API instead of Firestore
      fetch(`/api/presentations/${id}`, {
        headers: { 'teacher-id': user.id }
      })
        .then(res => res.json())
        .then(data => {
          if (data && !data.error) {
            if (data.slides) {
              data.slides = data.slides.map((s: any) => {
                if (s.type === 'matching' && !s.content.pairs) {
                  return { ...s, content: { ...s.content, pairs: [] } };
                }
                return s;
              });
            }
            setPresentationData(data);
          }
        })
        .catch(err => console.error("Failed to load presentation:", err));
    }
  }, [id, user.id]);

  useEffect(() => {
    if (timeLeft !== null && timeLeft > 0) {
      timerRef.current = setTimeout(() => setTimeLeft(timeLeft - 1), 1000);
    } else if (timeLeft === 0) {
      // Time up! Maybe auto-next or just lock responses
    }
    return () => clearTimeout(timerRef.current);
  }, [timeLeft]);

  useEffect(() => {
    if (currentSlide?.type === 'ordering') {
      const next = [...(currentSlide.content.orderingItems || [])];
      for (let i = next.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [next[i], next[j]] = [next[j], next[i]];
      }
      setHostOrderingPreview(next);
      return;
    }

    setHostOrderingPreview([]);
  }, [currentSlide]);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws.current = new WebSocket(`${protocol}//${window.location.host}`);

    ws.current.onopen = () => {
      setIsConnected(true);
      ws.current?.send(JSON.stringify({ type: 'HOST_START', presentationId: id }));
    };

    ws.current.onclose = () => setIsConnected(false);

    ws.current.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case 'ROOM_CREATED':
          setPin(msg.pin);
          if (msg.students) setStudents(msg.students);
          if (msg.currentSlide) setCurrentSlide(msg.currentSlide);
          break;
        case 'STUDENT_JOINED':
          setStudents(prev => [...prev, { id: msg.id, name: msg.name, avatarSeed: msg.avatarSeed }]);
          break;
        case 'STUDENT_LEFT':
          setStudents(prev => prev.filter(s => s.id !== msg.id));
          break;
        case 'SLIDE_UPDATE':
          console.log("Received slide update:", msg.slide);
          setCurrentSlide(msg.slide);
          setResponses({});
          if (msg.slide?.duration) {
            setTimeLeft(msg.slide.duration);
          } else {
            setTimeLeft(null);
          }
          break;
        case 'ERROR':
          alert(`Грешка: ${msg.message}`);
          break;
        case 'RESPONSE_RECEIVED':
          setResponses(prev => ({ ...prev, [msg.id]: msg.response }));
          if (msg.leaderboard) setLeaderboard(msg.leaderboard);
          break;
        case 'PRESENTATION_FINISHED':
          setLeaderboard(msg.leaderboard);
          setShowLeaderboard(true);
          setCurrentSlide(null);
          setIsFinished(true);
          // Auto-save report to database when finished via API
          const presentation = latestPresentationRef.current;
          if (presentation) {
            const token = localStorage.getItem('token');
            void (async () => {
              try {
                setIsSavingReport(true);
                const activePin = latestPinRef.current;
                if (!activePin) throw new Error('Missing PIN for auto-save report');

                const sessionReportRes = await fetch(`/api/sessions/${activePin}/report`);
                if (!sessionReportRes.ok) {
                  const errorBody = await sessionReportRes.text();
                  throw new Error(`Session report fetch failed (${sessionReportRes.status}): ${errorBody}`);
                }
                const sessionReportData = await sessionReportRes.json();

                const saveResponse = await fetch('/api/reports', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'teacher-id': latestTeacherIdRef.current,
                    ...(token ? { Authorization: `Bearer ${token}` } : {})
                  },
                  body: JSON.stringify({
                    presentationId: presentation.id,
                    presentationTitle: sessionReportData.presentationTitle || presentation.title,
                    privacyMode: latestPrivacyModeRef.current,
                    data: sessionReportData
                  })
                });

                if (!saveResponse.ok) {
                  const errorBody = await saveResponse.text();
                  throw new Error(`Auto-save report failed (${saveResponse.status}): ${errorBody}`);
                }

                setIsReportSaved(true);
                console.log('Report auto-saved successfully');
              } catch (err) {
                console.error("Auto-save report failed", err);
              } finally {
                setIsSavingReport(false);
              }
            })();
          }
          break;
      }
    };

    return () => ws.current?.close();
  }, [id]);

  const nextSlide = () => {
    ws.current?.send(JSON.stringify({ type: 'NEXT_SLIDE', pin, presentationId: id }));
  };

  const finishSession = async () => {
    if (!pin) return;
    if (isSavingReport) return;
    if (isReportSaved) {
      navigate('/reports');
      return;
    }

    try {
      setIsSavingReport(true);
      const token = localStorage.getItem('token');
      const res = await fetch(`/api/sessions/${pin}/report`);
      const data = await res.json();
      
      const saveResponse = await fetch('/api/reports', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'teacher-id': user.id,
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          presentationId: id,
          presentationTitle: data.presentationTitle,
          privacyMode: hostPrivacyMode,
          data: data
        })
      });

      if (!saveResponse.ok) {
        const errorBody = await saveResponse.text();
        throw new Error(`Report save failed (${saveResponse.status}): ${errorBody}`);
      }

      setIsReportSaved(true);
      navigate('/reports');
    } catch (err) {
      console.error("Failed to save report", err);
      alert('Не успяхме да запазим доклада в Архива. Опитайте отново.');
    } finally {
      setIsSavingReport(false);
    }
  };

  const downloadReport = async () => {
    if (!pin || isDownloadingReport) return;
    setIsDownloadingReport(true);
    try {
      const res = await fetch(`/api/sessions/${pin}/report`);
      if (!res.ok) {
        throw new Error(`Report fetch failed (${res.status})`);
      }
      const data = await res.json();
      
      const doc = new jsPDF();
      
      // Add Cyrillic support by loading a font
      try {
        const fontUrl = 'https://cdn.jsdelivr.net/gh/googlefonts/roboto@main/src/hinted/Roboto-Regular.ttf';
        const fontRes = await fetch(fontUrl);
        const fontBuffer = await fontRes.arrayBuffer();
        const fontBase64 = btoa(
          new Uint8Array(fontBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
        );
        doc.addFileToVFS('Roboto-Regular.ttf', fontBase64);
        doc.addFont('Roboto-Regular.ttf', 'Roboto', 'normal');
        doc.setFont('Roboto');
      } catch (e) {
        console.warn("Could not load Cyrillic font, falling back to default", e);
      }
      
      // Title
      doc.setFontSize(22);
      doc.text("Отчет от презентация", 105, 20, { align: "center" });
      
      doc.setFontSize(16);
      doc.text(data.presentationTitle, 105, 30, { align: "center" });
      
      doc.setFontSize(12);
      doc.text(`Дата: ${data.date}`, 20, 45);
      doc.text(`PIN: ${pin}`, 20, 52);
      
      // Summary Stats
      const totalStudents = data.students.length;
      const avgScore = data.students.reduce((acc: number, s: any) => acc + s.score, 0) / (totalStudents || 1);
      
      doc.text(`Брой ученици: ${totalStudents}`, 20, 65);
      doc.text(`Среден резултат: ${avgScore.toFixed(1)} т.`, 20, 72);

      // Student Scores Table
      const tableData = data.students
        .sort((a: any, b: any) => b.score - a.score)
        .map((s: any, i: number) => [i + 1, s.name, s.score]);
      
      autoTable(doc, {
        startY: 80,
        head: [['#', 'Име на ученик', 'Точки']],
        body: tableData,
        theme: 'striped',
        headStyles: { fillColor: [79, 70, 229], font: 'Roboto', fontStyle: 'normal' },
        styles: { font: 'Roboto', fontStyle: 'normal' }
      });

      // Question Analysis
      let currentY = (doc as any).lastAutoTable.finalY + 20;
      doc.setFontSize(16);
      doc.text("Анализ по въпроси", 20, currentY);
      currentY += 10;

      data.slides.forEach((slide: any, idx: number) => {
        if (['quiz-single', 'quiz-multi', 'boolean', 'hotspot', 'labeling', 'matching', 'ordering', 'categorization'].includes(slide.type)) {
          if (currentY > 250) {
            doc.addPage();
            currentY = 20;
            doc.setFont('Roboto');
          }

          const responses = data.students.map((s: any) => getResponseForSlide(s, idx, slide)).filter((r: any) => r !== undefined && r !== null);
          let correctCount = 0;

          responses.forEach((resp: any) => {
            if (isResponseCorrectForSlide(slide, resp)) correctCount++;
          });

          const successRate = responses.length ? (correctCount / responses.length) * 100 : 0;

          doc.setFontSize(12);
          doc.setFont("Roboto", "normal");
          doc.text(`Въпрос ${idx + 1}: ${slide.content.title}`, 20, currentY);
          doc.setFont("Roboto", "normal");
          doc.text(`Успеваемост: ${successRate.toFixed(1)}% (${correctCount}/${totalStudents})`, 20, currentY + 7);
          currentY += 20;
        }
      });
      
      doc.save(`report-${pin}.pdf`);
    } catch (err) {
      console.error("Failed to download report", err);
      alert('Не успяхме да изтеглим отчета. Опитайте отново.');
    } finally {
      setIsDownloadingReport(false);
    }
  };

  const chartData = useMemo(() => {
    if (!currentSlide || !currentSlide.content.options) return [];
    
    return currentSlide.content.options.map((opt: any, idx: number) => {
      const count = Object.values(responses).filter(r => 
        Array.isArray(r) ? r.includes(idx) : r === idx
      ).length;
      return {
        name: opt.text,
        votes: count,
        isCorrect: opt.isCorrect
      };
    });
  }, [currentSlide, responses]);

  if (!pin) return (
    <div className="h-screen flex items-center justify-center bg-indigo-600 text-white">
      <div className="text-center">
        <Loader2 className="w-12 h-12 animate-spin mx-auto mb-4" />
        <p className="text-xl">Генериране на PIN код...</p>
      </div>
    </div>
  );

  const startPresentation = () => {
    if (!pin) return;
    ws.current?.send(JSON.stringify({ 
      type: 'START_PRESENTATION', 
      pin, 
      presentationId: id,
      privacyMode: hostPrivacyMode 
    }));
  };

  // Lobby or Finished
  if (!currentSlide) {
    const joinUrl = `${window.location.origin}/join?pin=${pin}`;
    
    if (isFinished) {
      return (
        <div className="h-screen bg-indigo-600 text-white flex flex-col items-center justify-center p-12">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white text-gray-900 p-12 rounded-[3rem] shadow-2xl max-w-4xl w-full text-center"
          >
            <Award className="w-24 h-24 text-yellow-500 mx-auto mb-6" />
            <h1 className="text-5xl font-black mb-2 uppercase tracking-tighter">Край на урока!</h1>
            <p className="text-gray-500 text-xl mb-12">Поздравления за всички участници!</p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
              <div className="space-y-6">
                <h3 className="text-2xl font-black text-left flex items-center gap-2">
                  <Users className="text-indigo-600" /> Финално класиране
                </h3>
                <div className="space-y-4">
                  {leaderboard.map((s, i) => (
                    <div key={i} className="flex items-center justify-between p-4 bg-gray-50 rounded-2xl border border-gray-100">
                      <div className="flex items-center gap-3">
                        <span className={`w-8 h-8 rounded-full flex items-center justify-center font-bold ${i === 0 ? 'bg-yellow-400 text-yellow-900' : i === 1 ? 'bg-gray-300 text-gray-800' : 'bg-orange-400 text-orange-900'}`}>
                          {i + 1}
                        </span>
                        <img src={getAvatarUrl(s.avatarSeed || s.name)} className="w-10 h-10" alt="avatar" />
                        <span className="font-bold text-lg">{s.name}</span>
                      </div>
                      <span className="font-black text-2xl text-indigo-600">{s.score}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex flex-col justify-center gap-6">
                <div className="bg-indigo-50 p-8 rounded-3xl border border-indigo-100">
                  <h4 className="text-indigo-600 font-bold mb-2">Общо ученици</h4>
                  <div className="text-5xl font-black">{students.length}</div>
                </div>
                <Button className="h-16 text-xl" onClick={downloadReport} disabled={isDownloadingReport}>
                  <Download className="w-6 h-6" /> {isDownloadingReport ? 'Генериране...' : 'Изтегли PDF Отчет'}
                </Button>
                <Button variant="secondary" className="h-16 text-xl" onClick={finishSession} disabled={isSavingReport}>
                  {isSavingReport ? 'Запазване...' : isReportSaved ? 'Към Доклади' : 'Запази в Доклади'}
                </Button>
                <Button variant="ghost" className="h-16 text-xl" onClick={() => navigate('/')}>
                  Към Таблото
                </Button>
                <p className="text-xs text-gray-400">{isReportSaved ? 'Докладът е запазен в Архив.' : 'За да се появи в Архив на сесиите, натиснете „Запази в Доклади“.'}</p>
              </div>
            </div>
          </motion.div>
        </div>
      );
    }

    return (
      <div className="h-screen bg-indigo-600 text-white flex flex-col p-12">
        <div className="flex-1 flex flex-col items-center justify-center">
          <div className="flex flex-col md:flex-row items-center gap-12 mb-8">
            <div className="text-center">
              <p className="text-2xl opacity-80 mb-4">Присъединете се на:</p>
              <h1 className="text-8xl font-black tracking-widest mb-4">{pin}</h1>
              <p className="text-xl opacity-60">или сканирайте QR кода</p>
            </div>
            <div className="bg-white p-6 rounded-3xl shadow-2xl">
              <QRCodeSVG 
                value={joinUrl || ''} 
                size={200}
                level="H"
                includeMargin={false}
                imageSettings={{
                  src: "https://lucide.dev/logo.svg",
                  x: undefined,
                  y: undefined,
                  height: 40,
                  width: 40,
                  excavate: true,
                }}
              />
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-xl bg-white/10 px-6 py-3 rounded-full">
              <Users className="w-6 h-6" />
              <span>{students.length} ученици са тук</span>
            </div>
            {presentationData && presentationData.slides.length === 0 && (
              <div className="bg-red-500/20 text-red-200 px-6 py-3 rounded-full border border-red-500/50 flex items-center gap-2">
                <X className="w-5 h-5" />
                <span>Презентацията няма слайдове!</span>
              </div>
            )}
            <Button 
              variant="ghost" 
              className="text-white/60 hover:text-white hover:bg-white/10"
              onClick={() => ws.current?.send(JSON.stringify({ type: 'HOST_START', presentationId: id }))}
            >
              <Loader2 className="w-4 h-4" /> Опресни списъка
            </Button>
          </div>
        </div>
        
        <div className="grid grid-cols-6 gap-4 mb-12">
          <AnimatePresence>
            {students.map(s => (
              <motion.div 
                key={s.id}
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0, opacity: 0 }}
                className="bg-white/20 p-4 rounded-2xl text-center font-bold flex flex-col items-center gap-2"
              >
                <img src={getAvatarUrl(s.avatarSeed || s.name)} className="w-12 h-12" alt="avatar" />
                <span className="truncate w-full">{s.name}</span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        <Button 
          variant="primary" 
          className="w-full max-w-md mx-auto h-16 text-xl shadow-xl mb-4"
          onClick={startPresentation}
          disabled={students.length === 0 || (presentationData?.slides.length === 0)}
        >
          Започни Презентацията
        </Button>

        <div className="flex items-center justify-center gap-3 text-white/60">
          <input 
            type="checkbox" 
            id="privacy-mode" 
            checked={hostPrivacyMode}
            onChange={(e) => setHostPrivacyMode(e.target.checked)}
            className="w-5 h-5 rounded border-white/20 bg-white/10 text-indigo-500 focus:ring-indigo-500"
          />
          <label htmlFor="privacy-mode" className="text-sm font-bold flex items-center gap-2 cursor-pointer select-none">
            <Shield className="w-4 h-4" /> Режим за поверителност (Анонимни ученици в отчета)
          </label>
        </div>
      </div>
    );
  }

  // Presentation View
  return (
    <div className="h-screen flex flex-col bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-8 py-4 flex justify-between items-center">
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={() => navigate('/')}><ChevronLeft className="w-4 h-4" /> Назад</Button>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`} />
            <div className="bg-indigo-600 text-white px-4 py-1 rounded-full font-bold">PIN: {pin}</div>
          </div>
          <h2 className="text-xl font-bold text-gray-900">{currentSlide.content.title}</h2>
        </div>
        <div className="flex items-center gap-6">
          <Button variant="secondary" onClick={() => {
            const newState = !showLeaderboard;
            setShowLeaderboard(newState);
            ws.current?.send(JSON.stringify({ type: 'TOGGLE_LEADERBOARD', pin, show: newState }));
          }}>
            <Users className="w-4 h-4" /> Класация
          </Button>
          <Button variant="secondary" onClick={downloadReport}>
            <Download className="w-4 h-4" /> PDF Отчет
          </Button>
          {timeLeft !== null && (
            <div className={`flex items-center gap-2 font-black text-2xl ${timeLeft < 10 ? 'text-red-500 animate-pulse' : 'text-indigo-600'}`}>
              <Loader2 className={`w-6 h-6 ${timeLeft > 0 ? 'animate-spin' : ''}`} />
              {timeLeft}s
            </div>
          )}
          <div className="flex items-center gap-2 text-gray-500">
            <Users className="w-5 h-5" />
            <span className="font-bold">{Object.keys(responses).length} / {students.length}</span>
          </div>
          <Button onClick={nextSlide}>Следващ Слайд <ChevronRight className="w-4 h-4" /></Button>
          <Button variant="danger" onClick={finishSession}>Край</Button>
        </div>
      </header>

      <main className="flex-1 p-12 flex items-center justify-center relative">
        {presentationData?.globalBackgroundImage && (
          <div 
            className="absolute inset-0 opacity-20 pointer-events-none"
            style={{ backgroundImage: `url(${presentationData.globalBackgroundImage})`, backgroundSize: 'cover' }}
          />
        )}
        {showLeaderboard && (
          <motion.div 
            initial={{ x: 300, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 300, opacity: 0 }}
            className="absolute right-12 top-12 bottom-12 w-80 bg-white shadow-2xl rounded-3xl p-8 z-20 border border-gray-100"
          >
            <h3 className="text-2xl font-black mb-8 flex items-center gap-2">
              <Users className="text-indigo-600" /> Топ 5
            </h3>
            <div className="space-y-4">
              {leaderboard.map((s, i) => (
                <div key={i} className="flex items-center justify-between p-4 bg-gray-50 rounded-2xl">
                  <div className="flex items-center gap-3">
                    <span className="w-6 h-6 rounded-full bg-indigo-600 text-white text-[10px] flex items-center justify-center font-bold">
                      {i + 1}
                    </span>
                    <img src={getAvatarUrl(s.avatarSeed || s.name)} className="w-8 h-8" alt="avatar" />
                    <span className="font-bold">{s.name}</span>
                  </div>
                  <span className="font-black text-indigo-600">{s.score}</span>
                </div>
              ))}
            </div>
          </motion.div>
        )}

        <Card 
          className="w-full max-w-5xl min-h-[600px] flex flex-col p-12 overflow-hidden relative z-10 transition-colors"
          style={{ backgroundColor: currentSlide.content.backgroundColor || '#ffffff' }}
        >
          {presentationData?.globalBackgroundImage && (
            <div 
              className="absolute inset-0 opacity-15 pointer-events-none"
              style={{ backgroundImage: `url(${presentationData.globalBackgroundImage})`, backgroundSize: 'cover' }}
            />
          )}
          <h1 
            className="font-bold mb-8 text-center leading-tight relative z-10"
            style={{ 
              fontSize: `${currentSlide.content.titleSize || (currentSlide.type === 'title' ? 72 : 40)}px`,
              color: currentSlide.content.titleColor || '#000000'
            }}
          >
            {currentSlide.content.title}
          </h1>
          
          <div className="flex-1 flex flex-col items-center justify-center">
            {currentSlide.type === 'text-image' && (
              <div className={`flex gap-12 w-full items-center ${
                currentSlide.content.layout === 'top' ? 'flex-col' : 
                currentSlide.content.layout === 'bottom' ? 'flex-col-reverse' :
                currentSlide.content.layout === 'right' ? 'flex-row-reverse' : 
                currentSlide.content.layout === 'full' ? 'flex-col' : 'flex-row'
              }`}>
                <div className={`flex-1 ${currentSlide.content.layout === 'full' ? 'w-full text-center' : ''}`}>
                  <p 
                    className="leading-relaxed whitespace-pre-wrap"
                    style={{ 
                      fontSize: `${currentSlide.content.bodySize || 24}px`,
                      color: currentSlide.content.bodyColor || '#4b5563'
                    }}
                  >
                    {currentSlide.content.body}
                  </p>
                </div>
                {currentSlide.content.layout !== 'full' && currentSlide.content.imageUrl && (
                  <div className="flex-1 flex justify-center">
                    <img 
                      src={currentSlide.content.imageUrl} 
                      style={{ width: `${currentSlide.content.imageScale || 100}%` }}
                      className="rounded-2xl shadow-lg object-contain max-h-[60vh]" 
                      alt="Slide" 
                    />
                  </div>
                )}
              </div>
            )}

            {currentSlide.type === 'video' && currentSlide.content.videoUrl && (
              <div className="w-full aspect-video rounded-2xl overflow-hidden shadow-2xl bg-black">
                {currentSlide.content.videoUrl.includes('youtube.com') || currentSlide.content.videoUrl.includes('youtu.be') ? (
                  <iframe 
                    className="w-full h-full"
                    src={getYouTubeEmbedUrl(currentSlide.content.videoUrl)}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  />
                ) : (
                  <video src={currentSlide.content.videoUrl} controls className="w-full h-full" />
                )}
              </div>
            )}

            {(currentSlide.type === 'quiz-single' || currentSlide.type === 'quiz-multi' || currentSlide.type === 'boolean') && (
              <div className="w-full h-[400px] mt-8">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 14, fontWeight: 600 }} />
                    <YAxis hide />
                    <Tooltip 
                      cursor={{ fill: 'rgba(79, 70, 229, 0.05)' }}
                      content={({ active, payload }) => {
                        if (active && payload && payload.length) {
                          return (
                            <div className="bg-white p-4 shadow-xl rounded-xl border border-gray-100">
                              <p className="font-bold text-gray-900">{payload[0].payload.name}</p>
                              <p className="text-indigo-600 font-black text-xl">{payload[0].value} гласа</p>
                            </div>
                          );
                        }
                        return null;
                      }}
                    />
                    <Bar dataKey="votes" radius={[10, 10, 0, 0]}>
                      {chartData.map((entry: any, index: number) => (
                        <Cell 
                          key={`cell-${index}`} 
                          fill={entry.isCorrect ? '#10b981' : '#4f46e5'} 
                          fillOpacity={entry.isCorrect ? 0.8 : 0.6}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <div className={`grid ${currentSlide.type === 'boolean' ? 'grid-cols-2' : 'grid-cols-2 md:grid-cols-4'} gap-4 mt-8`}>
                  {currentSlide.content.options.map((opt: any, i: number) => (
                    <div key={i} className="flex items-center gap-3 p-4 bg-white rounded-xl shadow-sm border border-gray-100">
                      <div className={`w-4 h-4 rounded-full ${opt.isCorrect ? 'bg-green-500' : 'bg-indigo-500'}`} />
                      <span className="font-medium text-gray-700">{opt.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {currentSlide.type === 'hotspot' && (
              <div className="w-full flex-1 flex flex-col items-center">
                <div className="relative aspect-video bg-gray-100 rounded-2xl overflow-hidden border border-gray-200 w-full max-w-4xl">
                  {currentSlide.content.imageUrl && (
                    <img src={currentSlide.content.imageUrl} className="absolute inset-0 w-full h-full object-contain" alt="Hotspot" />
                  )}
                  {/* Student Clicks */}
                  {Object.entries(responses).map(([sid, resp]: [string, any]) => (
                    <div 
                      key={sid}
                      className="absolute w-4 h-4 bg-indigo-600 rounded-full border-2 border-white shadow-lg z-20"
                      style={{
                        left: `${resp.x}%`,
                        top: `${resp.y}%`,
                        transform: 'translate(-50%, -50%)'
                      }}
                    />
                  ))}
                </div>
                <div className="mt-6 flex gap-6">
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded-full bg-indigo-600" />
                    <span className="text-sm font-bold text-gray-500">Кликове на ученици ({Object.keys(responses).length})</span>
                  </div>
                </div>
              </div>
            )}

            {currentSlide.type === 'matching' && (
              <div className="w-full flex-1 flex flex-col items-center">
                <div className="grid grid-cols-2 gap-24 w-full max-w-4xl relative">
                  {/* Left Column */}
                  <div className="space-y-4">
                    {currentSlide.content.pairs?.map((pair: any) => (
                      <div key={`left-${pair.id}`} className="bg-white p-6 rounded-2xl shadow-sm border-2 border-gray-100 text-center font-bold text-xl">
                        {pair.left}
                      </div>
                    ))}
                  </div>
                  {/* Right Column - Shuffled for Host to not show answers */}
                  <div className="space-y-4">
                    {[...(currentSlide.content.pairs || [])]
                      .sort((a, b) => a.id.localeCompare(b.id)) // Stable sort first
                      .sort((a, b) => {
                        // Use slide ID as seed for pseudo-random shuffle that's stable for this slide
                        const seed = currentSlide.id || 'seed';
                        const hash = (str: string) => {
                          let h = 0;
                          for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
                          return h;
                        };
                        return hash(a.id + seed) - hash(b.id + seed);
                      })
                      .map((pair: any) => (
                        <div key={`right-${pair.id}`} className="bg-white p-6 rounded-2xl shadow-sm border-2 border-gray-100 text-center font-bold text-xl">
                          {pair.right}
                        </div>
                      ))}
                  </div>
                </div>
                <div className="mt-12 text-gray-400 font-bold uppercase tracking-widest">
                  Учениците свързват двойките... ({Object.keys(responses).length} отговора)
                </div>
              </div>
            )}

            {currentSlide.type === 'labeling' && (
              <div className="w-full flex-1 flex flex-col items-center">
                <div className="relative aspect-video bg-gray-100 rounded-2xl overflow-hidden border border-gray-200 w-full max-w-4xl">
                  {currentSlide.content.imageUrl && (
                    <img src={currentSlide.content.imageUrl} className="absolute inset-0 w-full h-full object-contain" alt="Labeling" />
                  )}
                  {/* Drop Zones (Visible to Host) */}
                  {currentSlide.content.labels?.map((label: any) => (
                    <div 
                      key={`zone-${label.id}`}
                      className="absolute border-2 border-dashed border-indigo-300 bg-indigo-50/30 rounded-lg flex items-center justify-center"
                      style={{
                        left: `${label.x}%`,
                        top: `${label.y}%`,
                        width: '100px',
                        height: '40px',
                        transform: 'translate(-50%, -50%)'
                      }}
                    >
                      <div className="w-1 h-1 bg-indigo-300 rounded-full" />
                    </div>
                  ))}
                  {/* Student Progress Dots */}
                  {Object.entries(responses).map(([sid, resp]: [string, any]) => (
                    Object.entries(resp || {}).map(([labelId, pos]: [string, any]) => (
                      <div 
                        key={`${sid}-${labelId}`}
                        className="absolute w-2 h-2 bg-indigo-600 rounded-full border border-white shadow-sm z-20"
                        style={{
                          left: `${pos.x}%`,
                          top: `${pos.y}%`,
                          transform: 'translate(-50%, -50%)'
                        }}
                      />
                    ))
                  ))}
                </div>
                <div className="mt-6 flex gap-6">
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded-full bg-indigo-600" />
                    <span className="text-sm font-bold text-gray-500">Позиции на етикетите ({Object.keys(responses).length} ученици)</span>
                  </div>
                </div>
              </div>
            )}

            {currentSlide.type === 'ordering' && (
              <div className="w-full max-w-2xl mx-auto space-y-3">
                {(hostOrderingPreview.length > 0 ? hostOrderingPreview : (currentSlide.content.orderingItems || [])).map((item: any) => (
                  <div key={item.id} className="bg-white border border-gray-100 rounded-xl p-4 font-bold text-gray-700 flex items-center gap-3">
                    <span className="text-indigo-400">•</span>
                    <span>{item.text}</span>
                  </div>
                ))}
                <div className="text-center text-gray-400 font-bold uppercase tracking-widest pt-4">Елементите са разбъркани за преглед (без верен ред). {Object.keys(responses).length} отговора</div>
              </div>
            )}

            {currentSlide.type === 'categorization' && (
              <div className="w-full grid md:grid-cols-3 gap-4">
                {(currentSlide.content.categories || []).map((cat: string) => (
                  <div key={cat} className="bg-white rounded-2xl border border-gray-100 p-4">
                    <h4 className="font-black text-indigo-600 mb-3">{cat}</h4>
                    <div className="space-y-2">
                      {(currentSlide.content.categoryItems || []).filter((it: any) => it.category === cat).map((it: any) => (
                        <div key={it.id} className="px-3 py-2 rounded-lg bg-indigo-50 text-indigo-700 font-semibold text-sm">{it.text}</div>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="md:col-span-3 text-center text-gray-400 font-bold uppercase tracking-widest">Учениците категоризират елементите... ({Object.keys(responses).length} отговора)</div>
              </div>
            )}

            {currentSlide.type === 'open-question' && (
              <div className="w-full grid grid-cols-2 gap-4 overflow-y-auto max-h-[400px] p-4">
                <AnimatePresence>
                  {Object.entries(responses).map(([sid, resp]) => (
                    <motion.div 
                      key={sid}
                      initial={{ scale: 0.8, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 text-xl font-medium"
                    >
                      {resp}
                    </motion.div>
                  ))}
                </AnimatePresence>
                {Object.keys(responses).length === 0 && (
                  <div className="col-span-2 text-center py-20 text-gray-300 italic">
                    Очакваме отговори...
                  </div>
                )}
              </div>
            )}
            {currentSlide.type === 'whiteboard' && (
              <div className="w-full flex-1 flex flex-col items-center justify-center">
                <div className="relative w-full aspect-video bg-white rounded-2xl border-2 border-dashed border-gray-200 flex items-center justify-center overflow-hidden">
                  {currentSlide.content.imageUrl && (
                    <img src={currentSlide.content.imageUrl} className="absolute inset-0 w-full h-full object-cover opacity-20" alt="BG" />
                  )}
                  <div className="text-center text-gray-400">
                    <Edit2 className="w-12 h-12 mx-auto mb-4 opacity-20" />
                    <p>Учениците рисуват в момента...</p>
                    <p className="text-sm mt-2">{Object.keys(responses).length} изпратени рисунки</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </Card>
      </main>
    </div>
  );
};

const StudentJoin = () => {
  const [searchParams] = useSearchParams();
  const [pin, setPin] = useState(searchParams.get('pin') || '');
  const [name, setName] = useState('');
  const [step, setStep] = useState<'pin' | 'name'>(searchParams.get('pin') ? 'name' : 'pin');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const handleJoin = () => {
    if (step === 'pin') {
      if (pin.length === 6) setStep('name');
      else setError('Моля въведете 6-цифрен PIN');
    } else {
      if (name.trim()) {
        navigate(`/play?pin=${pin}&name=${encodeURIComponent(name)}`);
      } else {
        setError('Моля въведете име');
      }
    }
  };

  return (
    <div className="h-screen bg-indigo-600 flex items-center justify-center p-6">
      <Card className="w-full max-w-md p-8">
        <h1 className="text-3xl font-black text-center text-indigo-600 mb-8 uppercase tracking-tighter">Join Class</h1>
        
        <div className="space-y-6">
          {step === 'pin' ? (
            <div>
              <label className="block text-xs font-bold text-gray-400 uppercase mb-2">Game PIN</label>
              <input 
                className="w-full h-16 text-center text-4xl font-black tracking-widest border-2 border-gray-200 rounded-xl focus:border-indigo-500 focus:ring-0"
                maxLength={6}
                value={pin || ''}
                onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
              />
            </div>
          ) : (
            <div>
              <label className="block text-xs font-bold text-gray-400 uppercase mb-2">Вашето Име</label>
              <input 
                className="w-full h-16 text-center text-2xl font-bold border-2 border-gray-200 rounded-xl focus:border-indigo-500 focus:ring-0"
                value={name || ''}
                onChange={e => setName(e.target.value)}
                placeholder="Име"
                autoFocus
              />
            </div>
          )}

          {error && <p className="text-red-500 text-sm text-center">{error}</p>}

          <Button className="w-full h-16 text-xl" onClick={handleJoin}>
            {step === 'pin' ? 'Напред' : 'Влез в играта'}
          </Button>
        </div>
      </Card>
    </div>
  );
};

const StudentView = () => {
  const [searchParams] = useSearchParams();
  const [currentSlide, setCurrentSlide] = useState<any>(null);
  const [submitted, setSubmitted] = useState(false);
  const [status, setStatus] = useState<'connecting' | 'waiting' | 'active' | 'closed'>('connecting');
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [openAnswer, setOpenAnswer] = useState('');
  const [presentationData, setPresentationData] = useState<Presentation | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [feedback, setFeedback] = useState<{ isCorrect: boolean, pointsEarned: number, totalScore: number } | null>(null);
  const [finalLeaderboard, setFinalLeaderboard] = useState<any[] | null>(null);
  const [finalScore, setFinalScore] = useState<number | null>(null);
  const [showStudentLeaderboard, setShowStudentLeaderboard] = useState(false);
  const timerRef = useRef<any>(null);
  const ws = useRef<WebSocket | null>(null);
  const navigate = useNavigate();


  useEffect(() => {
    if (timeLeft !== null && timeLeft > 0) {
      timerRef.current = setTimeout(() => setTimeLeft(timeLeft - 1), 1000);
    } else if (timeLeft === 0) {
      setSubmitted(true);
    }
    return () => clearTimeout(timerRef.current);
  }, [timeLeft]);

  useEffect(() => {
    const pin = searchParams.get('pin');
    const name = searchParams.get('name');

    if (!pin || !name) {
      navigate('/join');
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws.current = new WebSocket(`${protocol}//${window.location.host}`);

    ws.current.onopen = () => {
      setIsConnected(true);
      ws.current?.send(JSON.stringify({ type: 'JOIN_ROOM', pin, name }));
    };

    ws.current.onclose = () => setIsConnected(false);

    ws.current.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case 'JOIN_SUCCESS':
          setStatus('waiting');
          if (msg.presentation) setPresentationData(msg.presentation);
          if (msg.avatarSeed) localStorage.setItem('avatarSeed', msg.avatarSeed);
          break;
        case 'ERROR':
          alert(msg.message);
          navigate('/join');
          break;
        case 'SLIDE_UPDATE':
          if (msg.slide) {
            setCurrentSlide(msg.slide);
            setSubmitted(false);
            setFeedback(null);
            setShowStudentLeaderboard(false);
            setMultiResponses([]);
            setMatchingConnections({});
            setSelectedLeft(null);
            setStatus('active');
          } else {
            setStatus('waiting');
          }
          break;
        case 'SHOW_LEADERBOARD':
          setShowStudentLeaderboard(msg.show);
          if (msg.show) {
            setFinalScore(msg.yourScore);
            setFinalLeaderboard(msg.leaderboard);
          }
          break;
        case 'FEEDBACK':
          setFeedback({
            isCorrect: msg.isCorrect,
            pointsEarned: msg.pointsEarned,
            totalScore: msg.totalScore
          });
          break;
        case 'PRESENTATION_FINISHED':
          setFinalLeaderboard(msg.leaderboard);
          setFinalScore(msg.yourScore);
          setStatus('closed');
          break;
        case 'ROOM_CLOSED':
          setStatus('closed');
          break;
      }
    };

    return () => ws.current?.close();
  }, [searchParams, navigate]);

  const [multiResponses, setMultiResponses] = useState<number[]>([]);
  const [matchingConnections, setMatchingConnections] = useState<Record<string, string>>({});
  const [selectedLeft, setSelectedLeft] = useState<string | null>(null);
  const [orderingResponse, setOrderingResponse] = useState<{ id: string; text: string }[]>([]);
  const [draggedOrderingIndex, setDraggedOrderingIndex] = useState<number | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [categorizationResponse, setCategorizationResponse] = useState<Record<string, string>>({});

  const submitResponse = (response: any) => {
    ws.current?.send(JSON.stringify({ type: 'SUBMIT_RESPONSE', response }));
    setSubmitted(true);
  };

  const toggleMulti = (idx: number) => {
    setMultiResponses(prev => 
      prev.includes(idx) ? prev.filter(i => i !== idx) : [...prev, idx]
    );
  };

  const [labelPositions, setLabelPositions] = useState<Record<string, { x: number, y: number }>>({});
  const [shuffledRightItems, setShuffledRightItems] = useState<any[]>([]);

  useEffect(() => {
    if (currentSlide?.type === 'labeling') {
      setLabelPositions({});
    }
    if (currentSlide?.type === 'matching' && currentSlide.content.pairs) {
      const items = currentSlide.content.pairs.map((p: any) => ({ id: p.id, text: p.right }));
      // Fisher-Yates shuffle
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
      setShuffledRightItems(items);
    }
    if (currentSlide?.type === 'ordering') {
      const items = [...(currentSlide.content.orderingItems || [])];
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
      setOrderingResponse(items);
      setDraggedOrderingIndex(null);
    }
    if (currentSlide?.type === 'categorization') {
      setSelectedCategory((currentSlide.content.categories || [])[0] || null);
      setCategorizationResponse({});
    }
  }, [currentSlide]);

  if (status === 'closed') {
    return (
      <div className="h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-8 text-center">
        <motion.div 
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="bg-white/10 backdrop-blur-xl p-12 rounded-[3rem] border border-white/20 shadow-2xl max-w-lg w-full"
        >
          <Trophy className="w-24 h-24 mb-6 text-yellow-400 mx-auto" />
          <h1 className="text-4xl font-black mb-2">Край на урока!</h1>
          <p className="text-indigo-200 text-xl mb-8">Страхотна работа!</p>
          
          <div className="bg-indigo-600/50 p-8 rounded-3xl mb-12">
            <div className="text-sm font-bold text-indigo-200 uppercase tracking-widest mb-2">Твоят резултат</div>
            <div className="text-6xl font-black">{finalScore || 0}</div>
            <div className="text-indigo-200 mt-2 font-bold">точки</div>
          </div>

          {finalLeaderboard && (
            <div className="space-y-3 text-left mb-8">
              <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest mb-4">Топ 3 в класа</h3>
              {finalLeaderboard.slice(0, 3).map((s, i) => (
                <div key={i} className="flex items-center justify-between p-4 bg-white/5 rounded-2xl border border-white/10">
                  <div className="flex items-center gap-3">
                    <span className={`w-8 h-8 rounded-full flex items-center justify-center font-bold ${i === 0 ? 'bg-yellow-400 text-yellow-900' : i === 1 ? 'bg-gray-300 text-gray-800' : 'bg-orange-400 text-orange-900'}`}>
                      {i + 1}
                    </span>
                    <span className="font-bold">{s.name}</span>
                  </div>
                  <span className="font-black text-indigo-400">{s.score}</span>
                </div>
              ))}
            </div>
          )}

          <Button className="w-full h-16 text-xl" onClick={() => navigate('/join')}>Към началната страница</Button>
        </motion.div>
      </div>
    );
  }

  if (status === 'connecting') {
    return (
      <div className="h-screen bg-indigo-600 text-white flex flex-col items-center justify-center p-8 text-center">
        <Loader2 className="w-16 h-16 animate-spin mb-6" />
        <h1 className="text-3xl font-bold mb-2">Свързване...</h1>
      </div>
    );
  }

  if (status === 'waiting') {
    return (
      <div className="h-screen bg-indigo-600 text-white flex flex-col items-center justify-center p-8 text-center">
        <Loader2 className="w-16 h-16 animate-spin mb-6 opacity-50" />
        <h1 className="text-3xl font-bold mb-2">Готови ли сте?</h1>
        <p className="text-indigo-200">Изчакайте учителя да започне презентацията...</p>
      </div>
    );
  }

  return (
    <div className="h-screen bg-gray-50 flex flex-col">
      {presentationData?.globalBackgroundImage && (
        <div 
          className="fixed inset-0 opacity-10 pointer-events-none"
          style={{ backgroundImage: `url(${presentationData.globalBackgroundImage})`, backgroundSize: 'cover' }}
        />
      )}
      <header className="bg-white border-b border-gray-200 p-4 flex justify-between items-center relative z-10">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`} />
          <img src={getAvatarUrl(localStorage.getItem('avatarSeed') || searchParams.get('name') || 'user')} className="w-8 h-8" alt="avatar" />
          <span className="font-bold text-indigo-600">{searchParams.get('name')}</span>
          {timeLeft !== null && (
            <div className={`text-lg font-black ${timeLeft < 10 ? 'text-red-500' : 'text-indigo-600'}`}>
              {timeLeft}s
            </div>
          )}
        </div>
        <div className="bg-gray-100 px-3 py-1 rounded-full text-xs font-bold text-gray-500 uppercase">В сесия</div>
      </header>

      <main className="flex-1 p-6 flex flex-col overflow-y-auto relative z-10 transition-colors"
        style={{ backgroundColor: currentSlide.content.backgroundColor || '#ffffff' }}
      >
        {presentationData?.globalBackgroundImage && (
          <div 
            className="absolute inset-0 opacity-15 pointer-events-none"
            style={{ backgroundImage: `url(${presentationData.globalBackgroundImage})`, backgroundSize: 'cover' }}
          />
        )}

        {showStudentLeaderboard ? (
          <div className="flex-1 flex flex-col items-center justify-center">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white p-8 rounded-[3rem] shadow-2xl border border-gray-100 max-w-md w-full text-center"
            >
              <Award className="w-20 h-20 text-yellow-500 mx-auto mb-6" />
              <h2 className="text-3xl font-black mb-2 text-gray-900 uppercase tracking-tighter">Твоят резултат</h2>
              <div className="text-6xl font-black text-indigo-600 mb-8">{finalScore || 0}</div>
              
              {finalLeaderboard && (
                <div className="space-y-3 text-left">
                  <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4">Топ в класа</h3>
                  {finalLeaderboard.slice(0, 3).map((s, i) => (
                    <div key={i} className="flex items-center justify-between p-4 bg-gray-50 rounded-2xl border border-gray-100">
                      <div className="flex items-center gap-3">
                        <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${i === 0 ? 'bg-yellow-400 text-yellow-900' : 'bg-gray-200 text-gray-600'}`}>
                          {i + 1}
                        </span>
                        <span className="font-bold text-gray-700">{s.name}</span>
                      </div>
                      <span className="font-black text-indigo-600">{s.score}</span>
                    </div>
                  ))}
                </div>
              )}
            </motion.div>
          </div>
        ) : (
          <>
            <h1 
              className="font-bold text-center mb-8 relative z-20"
              style={{ 
                fontSize: `${currentSlide.content.titleSize ? currentSlide.content.titleSize / 1.5 : 24}px`,
                color: currentSlide.content.titleColor || '#000000'
              }}
            >
              {currentSlide.content.title}
            </h1>

            <div className="flex-1 flex flex-col relative z-20">
              {['title', 'text-image', 'video'].includes(currentSlide.type) ? (
            <div className="flex-1 flex items-center justify-center text-center text-gray-500">
            <div className="flex flex-col items-center gap-4">
              <Layout className="w-12 h-12 opacity-20" />
              <p className="text-lg italic">Вижте екрана на учителя за съдържанието.</p>
            </div>
          </div>
        ) : (currentSlide.type === 'quiz-single' || currentSlide.type === 'boolean') ? (
          <div className="grid grid-cols-1 gap-4 flex-1">
            {currentSlide.content.options.map((opt: any, i: number) => (
              <button
                key={i}
                disabled={submitted}
                onClick={() => submitResponse(i)}
                className={`h-20 text-xl font-bold rounded-2xl border-b-4 transition-all active:translate-y-1 active:border-b-0 ${
                  submitted 
                    ? 'bg-gray-100 border-gray-200 text-gray-400' 
                    : 'bg-white border-gray-200 hover:bg-indigo-50 hover:border-indigo-200 text-gray-800 shadow-sm'
                }`}
              >
                {opt.text}
              </button>
            ))}
          </div>
        ) : currentSlide.type === 'quiz-multi' ? (
          <div className="flex flex-col gap-4 flex-1">
            <div className="grid grid-cols-1 gap-4">
              {currentSlide.content.options.map((opt: any, i: number) => (
                <button
                  key={i}
                  disabled={submitted}
                  onClick={() => toggleMulti(i)}
                  className={`h-20 text-xl font-bold rounded-2xl border-b-4 transition-all ${
                    submitted 
                      ? 'bg-gray-100 border-gray-200 text-gray-400' 
                      : multiResponses.includes(i)
                        ? 'bg-indigo-600 border-indigo-800 text-white'
                        : 'bg-white border-gray-200 text-gray-800 shadow-sm'
                  }`}
                >
                  {opt.text}
                </button>
              ))}
            </div>
            {!submitted && (
              <Button 
                className="h-16 text-xl mt-4" 
                onClick={() => submitResponse(multiResponses)}
                disabled={multiResponses.length === 0}
              >
                Изпрати отговорите
              </Button>
            )}
          </div>
        ) : currentSlide.type === 'hotspot' ? (
          <div className="flex-1 flex flex-col gap-4">
            <p className="text-center text-gray-500 font-medium">Докоснете вярната област на картинката</p>
            <div className="relative flex-1 bg-white rounded-3xl border-2 border-gray-200 overflow-hidden">
              {currentSlide.content.imageUrl && (
                <img 
                  src={currentSlide.content.imageUrl} 
                  className="w-full h-full object-contain" 
                  alt="Hotspot"
                  onClick={(e) => {
                    if (submitted) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const x = ((e.clientX - rect.left) / rect.width) * 100;
                    const y = ((e.clientY - rect.top) / rect.height) * 100;
                    submitResponse({ x, y });
                  }}
                />
              )}
            </div>
          </div>
        ) : currentSlide.type === 'open-question' ? (
          <div className="flex-1 flex flex-col gap-4">
            <textarea 
              disabled={submitted}
              className="flex-1 p-6 text-xl border-2 border-gray-200 rounded-3xl focus:border-indigo-500 focus:ring-0 resize-none"
              placeholder={currentSlide.content.placeholder || "Напишете вашия отговор тук..."}
              value={openAnswer || ''}
              onChange={e => setOpenAnswer(e.target.value)}
            />
            {!submitted && (
              <Button 
                className="h-16 text-xl" 
                onClick={() => submitResponse(openAnswer)}
                disabled={!openAnswer.trim()}
              >
                Изпрати отговора
              </Button>
            )}
          </div>
        ) : currentSlide.type === 'whiteboard' ? (
          <div className="flex-1 flex flex-col gap-4">
            <div className="flex-1 bg-white rounded-3xl border-2 border-gray-200 relative overflow-hidden">
              {currentSlide.content.imageUrl && (
                <img src={currentSlide.content.imageUrl} className="absolute inset-0 w-full h-full object-cover opacity-30" alt="BG" />
              )}
              <canvas 
                className="absolute inset-0 w-full h-full cursor-crosshair touch-none"
                onPointerDown={(e) => {
                  const canvas = e.currentTarget;
                  const rect = canvas.getBoundingClientRect();
                  const ctx = canvas.getContext('2d');
                  if (!ctx) return;
                  
                  // Set canvas internal resolution if not set
                  if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
                    canvas.width = canvas.clientWidth;
                    canvas.height = canvas.clientHeight;
                  }

                  ctx.beginPath();
                  ctx.lineWidth = 3;
                  ctx.lineCap = 'round';
                  ctx.strokeStyle = '#4f46e5';
                  ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
                  (canvas as any).isDrawing = true;
                }}
                onPointerMove={(e) => {
                  const canvas = e.currentTarget;
                  if (!(canvas as any).isDrawing) return;
                  const rect = canvas.getBoundingClientRect();
                  const ctx = canvas.getContext('2d');
                  if (!ctx) return;
                  ctx.lineTo(e.clientX - rect.left, e.clientY - rect.top);
                  ctx.stroke();
                }}
                onPointerUp={(e) => {
                  (e.currentTarget as any).isDrawing = false;
                }}
              />
            </div>
            {!submitted && (
              <Button className="h-16 text-xl" onClick={() => submitResponse('drawn')}>
                Изпрати рисунката
              </Button>
            )}
          </div>
        ) : currentSlide.type === 'matching' ? (
          <div className="flex-1 flex flex-col gap-6">
            <p className="text-center text-gray-500 font-medium">Свържете двойките, като изберете елемент отляво и след това отдясно</p>
            
            <div className="flex-1 grid grid-cols-2 gap-8 relative">
              {/* Left Column */}
              <div className="space-y-3">
                {currentSlide.content.pairs?.map((pair: any) => (
                  <button
                    key={`left-${pair.id}`}
                    disabled={submitted}
                    onClick={() => setSelectedLeft(pair.id)}
                    className={`w-full p-4 rounded-xl border-2 font-bold transition-all ${
                      selectedLeft === pair.id 
                        ? 'border-indigo-600 bg-indigo-50 shadow-md' 
                        : matchingConnections[pair.id]
                          ? 'border-green-200 bg-green-50 text-green-700'
                          : 'border-gray-200 bg-white hover:border-indigo-300'
                    }`}
                  >
                    {pair.left}
                  </button>
                ))}
              </div>

              {/* Right Column */}
              <div className="space-y-3">
                {shuffledRightItems.map((item: any) => {
                  const isConnected = Object.values(matchingConnections).includes(item.id);
                  const connectedToId = Object.keys(matchingConnections).find(key => matchingConnections[key] === item.id);

                  return (
                    <button
                      key={`right-${item.id}`}
                      disabled={submitted || !selectedLeft}
                      onClick={() => {
                        if (!selectedLeft) return;
                        setMatchingConnections(prev => ({ ...prev, [selectedLeft]: item.id }));
                        setSelectedLeft(null);
                      }}
                      className={`w-full p-4 rounded-xl border-2 font-bold transition-all ${
                        isConnected 
                          ? 'border-green-500 bg-green-600 text-white shadow-lg' 
                          : 'border-gray-200 bg-white hover:border-indigo-300'
                      }`}
                    >
                      {item.text}
                    </button>
                  );
                })}
              </div>

              {/* Reset Button */}
              {!submitted && Object.keys(matchingConnections).length > 0 && (
                <button 
                  className="absolute -bottom-4 left-1/2 -translate-x-1/2 text-xs font-bold text-indigo-600 hover:underline"
                  onClick={() => {
                    setMatchingConnections({});
                    setSelectedLeft(null);
                  }}
                >
                  Изчисти връзките
                </button>
              )}
            </div>

            {!submitted && (
              <Button 
                className="h-16 text-xl" 
                onClick={() => submitResponse(matchingConnections)}
                disabled={Object.keys(matchingConnections).length < (currentSlide.content.pairs?.length || 0)}
              >
                Изпрати отговорите
              </Button>
            )}
          </div>
        
        ) : currentSlide.type === 'ordering' ? (
          <div className="flex-1 flex flex-col gap-6">
            <p className="text-center text-gray-500 font-medium">Подредете елементите в правилен ред</p>
            {!submitted && (
              <div className="flex items-center justify-center gap-3">
                <Button variant="secondary" className="px-4 py-2" onClick={() => {
                  const next = [...orderingResponse];
                  for (let i = next.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [next[i], next[j]] = [next[j], next[i]];
                  }
                  setOrderingResponse(next);
                  setDraggedOrderingIndex(null);
                }}>
                  Разбъркай
                </Button>
                <div className="text-xs font-bold text-gray-400 uppercase tracking-widest">{orderingResponse.length} елемента</div>
              </div>
            )}
            <div className="space-y-3">
              {orderingResponse.map((item, idx) => (
                <div
                  key={item.id}
                  draggable={!submitted}
                  onDragStart={() => {
                    if (submitted) return;
                    setDraggedOrderingIndex(idx);
                  }}
                  onDragOver={(e) => {
                    if (submitted) return;
                    e.preventDefault();
                  }}
                  onDrop={() => {
                    if (submitted || draggedOrderingIndex === null || draggedOrderingIndex === idx) return;
                    const next = [...orderingResponse];
                    const [moved] = next.splice(draggedOrderingIndex, 1);
                    next.splice(idx, 0, moved);
                    setOrderingResponse(next);
                    setDraggedOrderingIndex(idx);
                  }}
                  onDragEnd={() => setDraggedOrderingIndex(null)}
                  className={`bg-white p-4 rounded-xl border flex items-center gap-3 transition ${draggedOrderingIndex === idx ? 'border-indigo-300 shadow-sm' : 'border-gray-100'} ${submitted ? '' : 'cursor-grab active:cursor-grabbing'}`}
                >
                  <span className="w-6 text-center font-black text-indigo-400">{idx + 1}</span>
                  <div className="flex-1 font-semibold text-gray-700">{item.text}</div>
                  {!submitted && <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">Провлечи</span>}
                </div>
              ))}
            </div>
            {!submitted && (
              <Button className="h-16 text-xl" onClick={() => submitResponse(orderingResponse.map(i => i.id))} disabled={orderingResponse.length === 0}>Изпрати подреждането</Button>
            )}
          </div>
        ) : currentSlide.type === 'categorization' ? (
          <div className="flex-1 flex flex-col gap-6">
            <p className="text-center text-gray-500 font-medium">Изберете категория и поставете елементите</p>
            <div className="text-center text-xs font-bold text-gray-400 uppercase tracking-widest">
              {Object.keys(categorizationResponse).length}/{currentSlide.content.categoryItems?.length || 0} разпределени
            </div>
            <div className="flex flex-wrap gap-2 justify-center">
              {(currentSlide.content.categories || []).map((cat: string) => (
                <button key={cat} onClick={() => setSelectedCategory(cat)} className={`px-4 py-2 rounded-full border text-sm font-bold ${selectedCategory === cat ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white border-gray-200 text-gray-600'}`}>{cat}</button>
              ))}
            </div>
            {!submitted && (
              <div className="flex items-center justify-center">
                <Button variant="secondary" className="px-4 py-2" onClick={() => setCategorizationResponse({})}>Нулирай</Button>
              </div>
            )}
            {!submitted && (
              <div className="bg-white p-4 rounded-2xl border border-gray-100 flex flex-wrap gap-2 justify-center">
                {(currentSlide.content.categoryItems || []).filter((it: any) => !categorizationResponse[it.id]).map((it: any) => (
                  <button key={it.id} onClick={() => {
                    if (!selectedCategory) return;
                    setCategorizationResponse(prev => ({ ...prev, [it.id]: selectedCategory }));
                  }} className="px-3 py-2 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-100 font-semibold text-sm">{it.text}</button>
                ))}
              </div>
            )}
            <div className="grid md:grid-cols-3 gap-3">
              {(currentSlide.content.categories || []).map((cat: string) => (
                <div key={cat} className="bg-white rounded-2xl border border-gray-100 p-3">
                  <h4 className="font-black text-indigo-600 mb-2">{cat}</h4>
                  <div className="space-y-2 min-h-16">
                    {Object.entries(categorizationResponse).filter(([,c]) => c === cat).map(([itemId]) => {
                      const it = (currentSlide.content.categoryItems || []).find((x: any) => x.id === itemId);
                      if (!it) return null;
                      return (
                        <button key={itemId} disabled={submitted} onClick={() => {
                          const next = { ...categorizationResponse };
                          delete next[itemId];
                          setCategorizationResponse(next);
                        }} className="w-full text-left px-3 py-2 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-100 font-semibold text-sm">{it.text}</button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            {!submitted && (
              <Button className="h-16 text-xl" onClick={() => submitResponse(categorizationResponse)} disabled={Object.keys(categorizationResponse).length < (currentSlide.content.categoryItems?.length || 0)}>Изпрати категоризациите</Button>
            )}
          </div>
) : currentSlide.type === 'labeling' ? (
          <div className="flex-1 flex flex-col gap-6">
            <p className="text-center text-gray-500 font-medium">Поставете етикетите в правилните зони (има магнитно напасване при близост)</p>
            
            {/* Label Tray */}
            {!submitted && (
              <div className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex flex-wrap gap-3 justify-center">
                {currentSlide.content.labels?.filter((l: any) => !labelPositions[l.id]).map((label: any) => (
                  <div 
                    key={`tray-${label.id}`}
                    className="bg-indigo-50 px-4 py-2 rounded-lg border border-indigo-100 font-bold text-indigo-600 cursor-pointer hover:bg-indigo-100 transition-colors"
                    onClick={() => {
                      const zones = currentSlide.content.labels || [];
                      const occupied = new Set(Object.keys(labelPositions));
                      const firstFreeZone = zones.find((z: any) => !occupied.has(z.id));
                      const x = firstFreeZone?.x ?? 50;
                      const y = firstFreeZone?.y ?? 50;
                      setLabelPositions(prev => ({ ...prev, [label.id]: { x, y } }));
                    }}
                  >
                    {label.text}
                  </div>
                ))}
                {currentSlide.content.labels?.every((l: any) => labelPositions[l.id]) && (
                  <p className="text-xs text-gray-400 italic">Всички етикети са на терена. Можете да ги местите.</p>
                )}
              </div>
            )}

            <div 
              id="student-label-container"
              className="relative flex-1 bg-gray-100 rounded-3xl overflow-hidden border-2 border-gray-200 min-h-[400px]"
            >
              {currentSlide.content.imageUrl && (
                <img src={currentSlide.content.imageUrl} className="absolute inset-0 w-full h-full object-cover opacity-60" alt="BG" />
              )}
              
              {/* Drop Zones */}
              <div className="absolute inset-0 pointer-events-none">
                {currentSlide.content.labels?.map((label: any) => (
                  <div 
                    key={`zone-${label.id}`}
                    className="absolute border-2 border-dashed border-white bg-white/40 rounded-lg flex items-center justify-center"
                    style={{
                      left: `${label.x}%`,
                      top: `${label.y}%`,
                      width: '100px',
                      height: '40px',
                      transform: 'translate(-50%, -50%)'
                    }}
                  >
                    <div className="w-1 h-1 bg-white rounded-full" />
                  </div>
                ))}
              </div>

              <div className="absolute inset-0">
                {currentSlide.content.labels?.map((label: any, idx: number) => {
                  const pos = labelPositions[label.id];
                  if (!pos) return null;

                  return (
                    <motion.div
                      key={label.id}
                      drag={!submitted}
                      dragMomentum={false}
                      onDragEnd={(_, info) => {
                        const container = document.getElementById('student-label-container');
                        if (container) {
                          const rect = container.getBoundingClientRect();
                          const rawX = Math.max(0, Math.min(100, ((info.point.x - rect.left) / rect.width) * 100));
                          const rawY = Math.max(0, Math.min(100, ((info.point.y - rect.top) / rect.height) * 100));
                          const snap = (value: number, step = 2) => Math.round(value / step) * step;
                          const zones = currentSlide.content.labels || [];
                          const nearestZone = zones.reduce((best: any, zone: any) => {
                            const dist = Math.hypot(rawX - zone.x, rawY - zone.y);
                            if (!best || dist < best.dist) return { zone, dist };
                            return best;
                          }, null);

                          const shouldMagnet = nearestZone && nearestZone.dist <= 14;
                          const x = shouldMagnet ? nearestZone.zone.x : snap(rawX);
                          const y = shouldMagnet ? nearestZone.zone.y : snap(rawY);
                          setLabelPositions(prev => ({ ...prev, [label.id]: { x, y } }));
                        }
                      }}
                      className="absolute cursor-grab active:cursor-grabbing bg-white px-4 py-2 rounded-lg shadow-xl border-2 border-indigo-500 font-bold text-indigo-600 z-10 min-w-[100px] text-center"
                      style={{ 
                        left: `${pos.x}%`, 
                        top: `${pos.y}%`,
                        transform: 'translate(-50%, -50%)'
                      }}
                    >
                      {label.text}
                    </motion.div>
                  );
                })}
              </div>
            </div>
            {!submitted && (
              <Button 
                className="h-16 text-xl" 
                onClick={() => submitResponse(labelPositions)}
                disabled={Object.keys(labelPositions).length < (currentSlide.content.labels?.length || 0)}
              >
                Готово
              </Button>
            )}
          </div>
        ) : null}
        </div>
          </>
        )}

        {submitted && (
          <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6">
            <motion.div 
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white p-8 rounded-[2.5rem] shadow-2xl flex flex-col items-center gap-6 text-center max-w-xs w-full"
            >
              {feedback ? (
                <>
                  {feedback.isCorrect ? (
                    <>
                      <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center text-green-600">
                        <CheckCircle2 className="w-12 h-12" />
                      </div>
                      <div>
                        <h3 className="text-2xl font-black text-green-600">Вярно!</h3>
                        <p className="text-gray-500 font-bold">+{feedback.pointsEarned} точки</p>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="w-20 h-20 bg-red-100 rounded-full flex items-center justify-center text-red-600">
                        <XCircle className="w-12 h-12" />
                      </div>
                      <div>
                        <h3 className="text-2xl font-black text-red-600">Грешно</h3>
                        <p className="text-gray-500 font-bold">Опитай пак следващия път!</p>
                      </div>
                    </>
                  )}
                  <div className="w-full h-px bg-gray-100 my-2" />
                  <div className="text-sm font-bold text-gray-400 uppercase tracking-widest">Общ резултат</div>
                  <div className="text-3xl font-black text-indigo-600">{feedback.totalScore}</div>
                </>
              ) : (
                <>
                  <Loader2 className="w-12 h-12 text-indigo-600 animate-spin" />
                  <span className="text-xl font-bold">Отговорът е изпратен!</span>
                </>
              )}
            </motion.div>
          </div>
        )}
      </main>
    </div>
  );
};

export default function App() {
  const [user, setUser] = useState<User | null>(() => {
    try {
      const saved = localStorage.getItem('teacher_user');
      return saved ? JSON.parse(saved) : null;
    } catch (e) {
      console.error("Failed to parse user from localStorage", e);
      return null;
    }
  });

  const handleLogin = (user: User) => {
    setUser(user);
    localStorage.setItem('teacher_user', JSON.stringify(user));
  };

  const handleLogout = () => {
    setUser(null);
    localStorage.removeItem('teacher_user');
    localStorage.removeItem('token');
  };

  if (!user) {
    return (
      <Router>
        <div className="min-h-screen bg-slate-50 font-sans text-gray-900">
          <Routes>
            <Route path="/join" element={<StudentJoin />} />
            <Route path="/play" element={<StudentView />} />
            <Route path="*" element={<Auth onLogin={handleLogin} />} />
          </Routes>
        </div>
      </Router>
    );
  }

  return (
    <Router>
      <div className="min-h-screen bg-slate-50 font-sans text-gray-900">
        <Routes>
          <Route path="/reports" element={<ReportsDashboard user={user} />} />
          <Route path="/reports/:id" element={<ReportDetail user={user} />} />
          <Route path="/" element={<Dashboard user={user} onLogout={handleLogout} />} />
          <Route path="/edit/:id" element={<Editor user={user} />} />
          <Route path="/host/:id" element={<HostView user={user} />} />
          <Route path="/join" element={<StudentJoin />} />
          <Route path="/play" element={<StudentView />} />
        </Routes>
      </div>
    </Router>
  );
}
