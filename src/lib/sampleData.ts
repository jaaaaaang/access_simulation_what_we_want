import { Point, Line, Polygon } from '../types';

// A synthetic apartment complex directly in canvas coordinates
export const sampleBuildings: Polygon[] = [
    [{x: 200, y: 200}, {x: 400, y: 200}, {x: 400, y: 350}, {x: 200, y: 350}],
    [{x: 200, y: 500}, {x: 400, y: 500}, {x: 400, y: 650}, {x: 200, y: 650}],
    [{x: 600, y: 200}, {x: 800, y: 200}, {x: 800, y: 350}, {x: 600, y: 350}],
    [{x: 600, y: 500}, {x: 800, y: 500}, {x: 800, y: 650}, {x: 600, y: 650}],
    [{x: 400, y: 750}, {x: 600, y: 750}, {x: 600, y: 900}, {x: 400, y: 900}]
];

export const sampleVerandas: Line[] = [
    { start: {x: 200, y: 350}, end: {x: 400, y: 350} }, // South
    { start: {x: 200, y: 650}, end: {x: 400, y: 650} }, // South
    { start: {x: 600, y: 350}, end: {x: 800, y: 350} }, // South
    { start: {x: 600, y: 650}, end: {x: 800, y: 650} }, // South
    { start: {x: 400, y: 900}, end: {x: 600, y: 900} }  // South
];
