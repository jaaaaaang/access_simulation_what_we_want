import { Point, Line, Polygon } from '../types';

// A synthetic apartment complex directly in canvas coordinates
export const sampleBuildings: Polygon[] = [
    [{x: 200, y: 200}, {x: 400, y: 200}, {x: 400, y: 350}, {x: 200, y: 350}],
    [{x: 200, y: 500}, {x: 400, y: 500}, {x: 400, y: 650}, {x: 200, y: 650}],
    [{x: 600, y: 200}, {x: 800, y: 200}, {x: 800, y: 350}, {x: 600, y: 350}],
    [{x: 600, y: 500}, {x: 800, y: 500}, {x: 800, y: 650}, {x: 600, y: 650}],
    [{x: 400, y: 750}, {x: 600, y: 750}, {x: 600, y: 900}, {x: 400, y: 900}]
];

// 1차 베란다 (First Veranda): 아파트 남쪽 정면 창호 라인
export const sampleVerandas: Line[] = [
    { start: {x: 200, y: 350}, end: {x: 400, y: 350} }, // South
    { start: {x: 200, y: 650}, end: {x: 400, y: 650} }, // South
    { start: {x: 600, y: 350}, end: {x: 800, y: 350} }, // South
    { start: {x: 600, y: 650}, end: {x: 800, y: 650} }, // South
    { start: {x: 400, y: 900}, end: {x: 600, y: 900} }  // South
];

// 2차 베란다 (Second Veranda - Sample): 1차 베란다의 맞은편 (북쪽 반대변 창호 라인)
export const sampleSecondVerandas: Line[] = [
    { start: {x: 200, y: 200}, end: {x: 400, y: 200}, isSecond: true }, // North (Opposite to 1st)
    { start: {x: 200, y: 500}, end: {x: 400, y: 500}, isSecond: true }, // North (Opposite to 1st)
    { start: {x: 600, y: 200}, end: {x: 800, y: 200}, isSecond: true }, // North (Opposite to 1st)
    { start: {x: 600, y: 500}, end: {x: 800, y: 500}, isSecond: true }, // North (Opposite to 1st)
    { start: {x: 400, y: 750}, end: {x: 600, y: 750}, isSecond: true }  // North (Opposite to 1st)
];
