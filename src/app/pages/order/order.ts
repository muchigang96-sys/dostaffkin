import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Subscription } from 'rxjs';
import { Header } from '../../header/header';
import { DELIVERY_SIZES, DELIVERY_SPEEDS } from './order.config';

declare const ymaps: any;

type Calculation = {
  distance: number;
  duration: number;
  deliveryDuration: number;
  rate: number;
  basePrice: number;
  tollPrice: number;
  total: number;
};

@Component({
  selector: 'app-order',
  imports: [Header, ReactiveFormsModule, UpperCasePipe, ReactiveFormsModule],
  templateUrl: './order.html',
  styleUrl: './order.css'
})
export class Order implements OnInit, OnDestroy {
  public readonly sizes = DELIVERY_SIZES;
  public readonly speeds = DELIVERY_SPEEDS;
  // Учебный максимум для участка ПК-5 — М-10, а не тариф для любых дорог.
  public readonly tollRates = { 1: 2278, 2: 3189, 3: 4262, 4: 6513 } as const;
  public readonly vehicleCategory: keyof typeof this.tollRates = 1;
  public routeForm: FormGroup;
  public orderForm: FormGroup;
  public map: any;
  private mapRoute: any;
  private suggestions: any[] = [];
  private formSubscription: Subscription;
  private routeData: { distance: number; duration: number } | null = null;
  private requestId = 0;
  private destroyed = false;
  public orderId = signal<number | null>(null);
  public calculationResult = signal<Calculation | null>(null);
  public calculating = signal(false);
  public mapReady = signal(false);
  public calculationError = signal('');

  constructor(private formBuilder: FormBuilder) {
    this.routeForm = this.formBuilder.group({
      from: ['', [Validators.required, Validators.pattern(/\S/)]],
      to: ['', [Validators.required, Validators.pattern(/\S/)]],
      size: ['xs', Validators.required],
      speed: ['regular', Validators.required]
    });
    this.orderForm = this.formBuilder.group({
      name: ['', Validators.required],
      phone: ['', Validators.required],
      comment: ['']
    });
    let addresses = this.addressKey();
    this.formSubscription = this.routeForm.valueChanges.subscribe(() => {
      const current = this.addressKey();
      if (current !== addresses) {
        addresses = current;
        this.requestId++;
        this.routeData = null;
        this.calculating.set(false);
        this.calculationResult.set(null);
        this.calculationError.set('');
        if (this.map && this.mapRoute) this.map.geoObjects.remove(this.mapRoute);
        this.mapRoute = null;
      } else {
        this.updatePrice();
      }
    });
  }

  ngOnInit(): void {
    if (typeof ymaps === 'undefined') {
      this.calculationError.set('Не загрузились Яндекс Карты. Проверьте подключение API.');
      return;
    }
    ymaps.ready(() => {
      if (this.destroyed) return;
      try {
        this.map = new ymaps.Map('map', {
          center: [55.751244, 37.618423], zoom: 5, controls: ['zoomControl']
        });
        this.mapReady.set(true);
        for (const field of ['from', 'to']) {
          // Подсказки могут требовать отдельного ключа. Ручной ввод работает без них.
          try {
            const suggest = new ymaps.SuggestView(field);
            suggest.events.add('select', (event: any) => {
              this.routeForm.get(field)?.setValue(event.get('item')?.value ?? '');
            });
            this.suggestions.push(suggest);
          } catch { /* Адрес можно ввести вручную. */ }
        }
      } catch {
        this.calculationError.set('Не удалось открыть карту. Проверьте ключ API Яндекс Карт.');
      }
    });
  }

  public selectSize(size: string): void {
    if (this.sizes.some(item => item.value === size)) this.routeForm.get('size')?.setValue(size);
  }

  public selectSpeed(speed: string): void {
    if (this.speeds.some(item => item.value === speed)) this.routeForm.get('speed')?.setValue(speed);
  }

  public async calculateRoute(): Promise<void> {
    if (this.routeForm.invalid || !this.mapReady() || this.calculating()) {
      this.routeForm.markAllAsTouched();
      return;
    }
    const id = ++this.requestId;
    this.calculating.set(true);
    this.calculationError.set('');
    this.calculationResult.set(null);
    this.routeData = null;
    if (this.mapRoute) this.map.geoObjects.remove(this.mapRoute);
    this.mapRoute = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const route: any = await Promise.race([
        new Promise((resolve, reject) => {
          const multiRoute = new ymaps.multiRouter.MultiRoute({
            referencePoints: [this.routeForm.value.from.trim(), this.routeForm.value.to.trim()],
            params: { routingMode: 'auto' }
          }, { boundsAutoApply: true, zoomMargin: 40 });
          this.mapRoute = multiRoute;
          multiRoute.model.events.add('requestsuccess', () => resolve(multiRoute));
          multiRoute.model.events.add('requestfail', (event: any) => reject(event.get('error')));
          this.map.geoObjects.add(multiRoute);
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), 20000);
        })
      ]);
      if (id !== this.requestId || this.destroyed) return;
      const activeRoute = route.getActiveRoute();
      if (!activeRoute) throw new Error('No route found');
      const distance = Number(activeRoute.properties.get('distance')?.value) / 1000;
      const duration = Number(activeRoute.properties.get('duration')?.value);
      if (!Number.isFinite(distance) || distance <= 0 || !Number.isFinite(duration)) {
        throw new Error('invalid route');
      }
      this.mapRoute = route;
      this.routeData = { distance, duration };
      this.updatePrice();
    } catch (error) {
      console.error('Route calculation failed:', error);
      if (id === this.requestId && !this.destroyed) {
        this.calculationError.set('Не удалось построить маршрут. Уточните адреса или проверьте доступ к API Яндекс Карт.');
      }
    } finally {
      clearTimeout(timer);
      if (id === this.requestId && !this.destroyed) this.calculating.set(false);
    }
  }

  private updatePrice(): void {
    if (!this.routeData) return;
    const size = this.sizes.find(item => item.value === this.routeForm.value.size);
    if (!size) return;
    const basePrice = Math.max(size.min, Math.ceil(this.routeData.distance * size.rate));
    const tollPrice = this.routeForm.value.speed === 'fast' ? this.tollRates[this.vehicleCategory] : 0;
    const deliveryDuration = this.routeData.duration * (this.routeForm.value.speed === 'fast' ? 0.7 : 1);
    this.calculationResult.set({ ...this.routeData, deliveryDuration, rate: size.rate, basePrice, tollPrice, total: basePrice + tollPrice });
  }

  public money(value: number): string {
    return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(value);
  }

  public distanceText(value: number): string {
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value) + ' км';
  }

  public durationText(seconds: number): string {
    const minutes = Math.ceil(seconds / 60);
    const hours = Math.floor(minutes / 60);
    return hours ? hours + ' ч ' + (minutes % 60) + ' мин' : minutes + ' мин';
  }

  private addressKey(): string {
    return JSON.stringify([this.routeForm.value.from, this.routeForm.value.to]);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.requestId++;
    this.formSubscription.unsubscribe();
    this.suggestions.forEach(suggest => suggest.destroy());
    this.map?.destroy();
  }

  private failedCalculation() {
    this.calculationResult.set(null);
    alert('Не удалось построить маршрут. Проверьте адреса и выбранные параметры.');
  }

  public submitOrder() {
    const calculation = this.calculationResult();
    if (!calculation) {
      alert('Сначала рассчитайте стоимость, чтобы оформить заявку');
      return;
    }

    if (this.orderForm.invalid) {
      alert('Введите имя и корректный телефон');
      return;
    }

    const { name, phone, comment } = this.orderForm.getRawValue();
    const trimmedName = (name ?? '').trim();
    const trimmedPhone = (phone ?? '').trim();
    const trimmedComment = (comment ?? '').trim();

    const payload = {
      customer: { name: trimmedName, phone: trimmedPhone, comment: trimmedComment },
      calculation: calculation,
      createdAt: new Date().toISOString()
    };

    console.log(payload);
    this.orderId.set(1);
  }
}
