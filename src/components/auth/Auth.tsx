import React, { useState } from 'react';
import { Monitor } from 'lucide-react';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
} from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { Button } from '../ui/Button';
import { auth, db } from '../../lib/firebase';
import type { User } from '../../types/app';

interface AuthProps {
  onLogin: (user: User) => void;
}

export const Auth = ({ onLogin }: AuthProps) => {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!auth) {
      setError('Firebase не е конфигуриран. Моля, добавете API ключовете в настройките на проекта.');
      return;
    }

    setLoading(true);

    try {
      if (isLogin) {
        const result = await signInWithEmailAndPassword(auth, email, password);
        const user = result.user;
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        const userData = userDoc.exists()
          ? (userDoc.data() as User)
          : { id: user.uid, email: user.email || '', name: user.displayName || 'Учител' };
        onLogin(userData);
      } else {
        const result = await createUserWithEmailAndPassword(auth, email, password);
        const user = result.user;
        await updateProfile(user, { displayName: name });
        const userData = {
          id: user.uid,
          email: user.email || '',
          name,
        };
        await setDoc(doc(db, 'users', user.uid), userData);
        onLogin(userData);
      }
    } catch (err: any) {
      console.error('Auth Error:', err);
      if (err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
        setError('Невалиден имейл или парола');
      } else if (err.code === 'auth/email-already-in-use') {
        setError('Този имейл вече се използва');
      } else if (err.code === 'auth/weak-password') {
        setError('Паролата трябва да е поне 6 символа');
      } else if (err.code === 'auth/operation-not-allowed') {
        setError('Методът за вход не е активиран във Firebase Console (Authentication > Sign-in method)');
      } else {
        setError(`Грешка: ${err.message || err.code || 'Възникна проблем при аутентикация'}`);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-[2.5rem] shadow-2xl shadow-slate-200/50 p-10 border border-white">
        <div className="text-center mb-10">
          <div className="w-20 h-20 bg-indigo-500 rounded-[2rem] flex items-center justify-center mx-auto mb-6 shadow-2xl shadow-indigo-100">
            <Monitor className="text-white w-10 h-10" />
          </div>
          <h2 className="text-3xl font-black text-slate-900 tracking-tight">
            {isLogin ? 'Влезте в профила си' : 'Създайте облачен профил'}
          </h2>
          <p className="text-slate-400 font-medium mt-2 px-4">
            {isLogin
              ? 'Вашите презентации се пазят сигурно в облака и са достъпни от всеки компютър.'
              : 'Регистрирайте се, за да достъпвате уроците си от всяко място.'}
          </p>
        </div>

        <div className="mb-6">
          <p className="text-xs text-slate-400 font-bold uppercase tracking-widest text-center">Вход с имейл и парола</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {!isLogin && (
            <div>
              <label className="block text-[10px] font-black text-indigo-300 uppercase tracking-widest mb-2 ml-1">Име</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-5 py-4 rounded-2xl bg-slate-50 border-none focus:ring-2 focus:ring-indigo-500 outline-none transition-all placeholder-slate-300"
                placeholder="Вашето име"
              />
            </div>
          )}
          <div>
            <label className="block text-[10px] font-black text-indigo-300 uppercase tracking-widest mb-2 ml-1">Имейл</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-5 py-4 rounded-2xl bg-slate-50 border-none focus:ring-2 focus:ring-indigo-500 outline-none transition-all placeholder-slate-300"
              placeholder="email@example.com"
            />
          </div>
          <div>
            <label className="block text-[10px] font-black text-indigo-300 uppercase tracking-widest mb-2 ml-1">Парола</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-5 py-4 rounded-2xl bg-slate-50 border-none focus:ring-2 focus:ring-indigo-500 outline-none transition-all placeholder-slate-300"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="p-4 bg-rose-50 text-rose-500 text-xs font-bold rounded-2xl border border-rose-100">
              {error}
            </div>
          )}

          <Button className="w-full py-4 text-lg" loading={loading}>
            {isLogin ? 'Вход' : 'Регистрация'}
          </Button>
        </form>

        <div className="mt-8 text-center">
          <button
            onClick={() => setIsLogin(!isLogin)}
            className="text-indigo-500 font-bold text-sm hover:underline"
          >
            {isLogin ? 'Нямате профил? Регистрирайте се' : 'Вече имате профил? Влезте'}
          </button>
        </div>
      </div>
    </div>
  );
};
