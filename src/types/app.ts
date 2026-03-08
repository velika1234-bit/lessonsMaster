export type SlideType =
  | 'title'
  | 'text-image'
  | 'video'
  | 'quiz-single'
  | 'quiz-multi'
  | 'boolean'
  | 'labeling'
  | 'hotspot'
  | 'open-question'
  | 'whiteboard'
  | 'matching'
  | 'ordering'
  | 'categorization';

export interface SlideOption {
  text: string;
  isCorrect: boolean;
}

export interface Label {
  id: string;
  text: string;
  x: number;
  y: number;
}

export interface Hotspot {
  x: number;
  y: number;
  radius: number;
}

export interface Slide {
  id?: string;
  type: SlideType;
  duration?: number;
  points?: number;
  content: {
    title: string;
    body?: string;
    imageUrl?: string;
    videoUrl?: string;
    options?: SlideOption[];
    labels?: Label[];
    hotspot?: Hotspot;
    pairs?: { left: string; right: string; id: string }[];
    orderingItems?: { id: string; text: string }[];
    categories?: string[];
    categoryItems?: { id: string; text: string; category: string }[];
    backgroundImage?: string;
    placeholder?: string;
    titleSize?: number;
    titleColor?: string;
    bodySize?: number;
    bodyColor?: string;
    imageScale?: number;
    layout?: 'left' | 'right' | 'top' | 'bottom' | 'full';
  };
}

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Presentation {
  id: string;
  title: string;
  slides: Slide[];
  theme?: 'light' | 'dark' | 'indigo' | 'emerald' | 'sunset';
  globalBackgroundImage?: string;
}
