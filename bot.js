/**************************************************
 * bot.js — Объединённый файл с базой данных PostgreSQL,
 * Express-сервером, Telegram-ботом и интеграцией с WooCommerce
 **************************************************/

const express = require('express')
const { Telegraf, Markup } = require('telegraf')
const axios = require('axios')
const path = require('path')
const dotenv = require('dotenv')
const LocalSession = require('telegraf-session-local')
const morgan = require('morgan')
const cron = require('node-cron')
const { Pool } = require('pg') // Работаем через PostgreSQL

dotenv.config()

// ***********************
// ИНИЦИАЛИЗАЦИЯ ПУЛА PostgreSQL
// ***********************
const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
	ssl:
		process.env.NODE_ENV === 'production'
			? { rejectUnauthorized: false }
			: false,
})

pool
	.connect()
	.then(client => {
		console.log('Подключение к PostgreSQL успешно установлено')
		client.release()
	})
	.catch(err => console.error('Ошибка подключения к PostgreSQL:', err))

// ***********************
// Создание таблиц (если не существуют)
// ***********************
const createTables = async () => {
	try {
		// Таблица пользователей
		await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        chat_id TEXT PRIMARY KEY,
        name TEXT,
        phone TEXT,
        language TEXT,
        last_activity TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tashkent')
      )
    `)
		// Таблица заказов
		await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        merchant_trans_id TEXT,
        chat_id TEXT,
        totalAmount INTEGER,
        status TEXT,
        lang TEXT,
        cart JSONB,
        wc_order_id INTEGER,
        wc_order_key TEXT,
        created_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tashkent')
      )
    `)
		// Таблица корзин (сохранение всего объекта корзины)
		await pool.query(`
      CREATE TABLE IF NOT EXISTS carts (
        chat_id TEXT PRIMARY KEY,
        cart JSONB
      )
    `)
		// Новая таблица для отдельных записей товаров, добавленных в корзину
		await pool.query(`
      CREATE TABLE IF NOT EXISTS cart_items (
        id SERIAL PRIMARY KEY,
        chat_id TEXT,
        product_id INTEGER,
        sku TEXT,
        name TEXT,
        quantity INTEGER,
        price INTEGER,
        added_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tashkent')
      )
    `)
		console.log('Таблицы PostgreSQL успешно созданы или уже существуют.')
	} catch (err) {
		console.error('Ошибка при создании таблиц:', err)
	}
}
createTables()

// ***********************
// ИНИЦИАЛИЗАЦИЯ EXPRESS-СЕРВЕРА
// ***********************
const app = express()
const PORT = process.env.PORT || 3000
app.use(morgan('dev'))
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// ***********************
// ИНИЦИАЛИЗАЦИЯ TELEGRAM-БОТА
// ***********************
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN)
const localSession = new LocalSession({ database: 'session_db.json' })
bot.use(localSession.middleware())

// ***********************
// Middleware для обновления last_activity (не чаще 1 раза в 60 сек)
// ***********************
bot.use(async (ctx, next) => {
	if (ctx.from && ctx.from.id) {
		const now = Date.now()
		if (!ctx.session.lastActivity || now - ctx.session.lastActivity > 60000) {
			ctx.session.lastActivity = now
			pool
				.query(
					`UPDATE users SET last_activity = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Tashkent') WHERE chat_id = $1`,
					[ctx.from.id]
				)
				.catch(err => console.error('Ошибка обновления last_activity:', err))
		}
	}
	return next()
})

// ***********************
// Интеграция с Billz (получение JWT, товаров, категорий)
// ***********************
async function getJwtToken() {
	try {
		const resp = await axios.post(
			process.env.BILLZ_AUTH_URL,
			{ secret_token: process.env.BILLZ_SECRET_TOKEN },
			{
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
			}
		)
		if (resp.status === 200) {
			const token = resp.data.data.access_token
			console.log('Получен JWT токен Billz:', token)
			return token
		} else {
			console.error('Ошибка авторизации Billz:', resp.status, resp.data)
			return null
		}
	} catch (err) {
		console.error('Ошибка при auth Billz:', err)
		return null
	}
}

let cachedProducts = null
let cacheTimestamp = null
const CACHE_DURATION = 5 * 60 * 1000

async function getAllProducts(jwt) {
	const now = Date.now()
	if (
		cachedProducts &&
		cacheTimestamp &&
		now - cacheTimestamp < CACHE_DURATION
	) {
		console.log('Возвращаем закэшированные товары (Billz).')
		return cachedProducts
	}
	try {
		let all = []
		let page = 1
		const limit = 100
		while (true) {
			const r = await axios.get(process.env.BILLZ_PRODUCTS_URL, {
				headers: {
					Accept: 'application/json',
					Authorization: `Bearer ${jwt}`,
				},
				params: { page, limit },
			})
			if (r.status === 200) {
				const { products } = r.data
				if (!products || products.length === 0) break
				const filtered = products
					.filter(
						p =>
							p.shop_measurement_values &&
							p.shop_measurement_values.some(
								sm => sm.shop_id === process.env.DESIRED_SHOP_ID
							)
					)
					.map(p => {
						const shopM = p.shop_measurement_values.find(
							sm => sm.shop_id === process.env.DESIRED_SHOP_ID
						)
						const priceObj = p.shop_prices.find(
							pr =>
								pr.shop_id === process.env.DESIRED_SHOP_ID &&
								pr.retail_currency === 'UZS'
						)
						const price = priceObj ? priceObj.retail_price : 0
						return {
							id: p.id,
							sku: p.sku || '',
							name: p.name || (shopM ? shopM.name : 'Без названия'),
							brand_name: p.brand_name || 'Неизвестный бренд',
							price,
							qty: shopM ? shopM.active_measurement_value : 0,
							shop_name: shopM ? shopM.shop_name : 'Unknown Shop',
							main_image_url_full: p.main_image_url_full || '',
							photos: p.photos ? p.photos.map(ph => ph.photo_url) : [],
							categories: p.categories || [],
						}
					})
				all = [...all, ...filtered]
				console.log(`Billz page=${page}, товаров:${filtered.length}`)
				page++
			} else {
				console.error('Ошибка Billz get products:', r.status, r.data)
				break
			}
		}
		console.log(`Всего товаров Billz: ${all.length}`)
		cachedProducts = all
		cacheTimestamp = now
		return all
	} catch (err) {
		console.error('Ошибка getAllProducts Billz:', err)
		return []
	}
}

app.get('/api/products', async (req, res) => {
	console.log('GET /api/products, cat=', req.query.category)
	const jwt = await getJwtToken()
	if (!jwt) return res.status(500).json({ error: 'Billz auth error' })
	const products = await getAllProducts(jwt)
	const cat = req.query.category
	if (cat && cat !== 'Все' && cat !== 'Hammasi') {
		const filtered = products.filter(p =>
			p.categories.some(c => c.name === cat)
		)
		return res.json(filtered)
	}
	return res.json(products)
})

app.get('/api/categories', async (req, res) => {
	console.log('GET /api/categories')
	const jwt = await getJwtToken()
	if (!jwt) return res.status(500).json({ error: 'Billz auth error' })
	const products = await getAllProducts(jwt)
	const catSet = new Set()
	products.forEach(p => p.categories.forEach(ct => catSet.add(ct.name)))
	let cats = Array.from(catSet).sort()
	if (!cats.includes('Hammasi')) cats.unshift('Hammasi')
	if (!cats.includes('Все')) cats.unshift('Все')
	res.json(cats)
})

// ***********************
// Эндпоинт для сохранения всей корзины (из WebApp)
// ***********************
app.post('/save-cart', async (req, res) => {
	const { chat_id, cart } = req.body
	if (!chat_id || !cart) {
		return res
			.status(400)
			.json({ success: false, error: 'Некорректные данные' })
	}
	const cartJSON = JSON.stringify(cart)
	const query = `INSERT INTO carts (chat_id, cart)
                 VALUES ($1, $2)
                 ON CONFLICT (chat_id) DO UPDATE SET cart = EXCLUDED.cart`
	try {
		await pool.query(query, [chat_id, cartJSON])
		return res.json({ success: true })
	} catch (err) {
		console.error('Ошибка сохранения корзины в БД:', err)
		return res.status(500).json({ success: false, error: 'Ошибка сервера' })
	}
})

// ***********************
// Новый эндпоинт для добавления отдельного товара в корзину
// ***********************
app.post('/add-to-cart', async (req, res) => {
	console.log(
		`[${new Date().toISOString()}] [add-to-cart] Получен запрос:`,
		req.body
	)
	const { chat_id, product } = req.body
	if (!chat_id || !product || !product.sku) {
		console.error(
			`[${new Date().toISOString()}] [add-to-cart] Некорректные данные: chat_id=${chat_id}, product=`,
			product
		)
		return res
			.status(400)
			.json({ success: false, error: 'Некорректные данные' })
	}
	const query = `
    INSERT INTO cart_items (chat_id, product_id, sku, name, quantity, price)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (chat_id, sku)
    DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity
  `
	try {
		await pool.query(query, [
			chat_id,
			product.id,
			product.sku,
			product.name,
			product.quantity,
			product.price,
		])
		console.log(
			`[${new Date().toISOString()}] [add-to-cart] Товар успешно записан в БД.`
		)
		return res.json({ success: true })
	} catch (err) {
		console.error(
			`[${new Date().toISOString()}] [add-to-cart] Ошибка записи товара в БД:`,
			err
		)
		return res.status(500).json({ success: false, error: 'Ошибка сервера' })
	}
})

// ***********************
// Функция поиска товара в WooCommerce по SKU с подробным логированием
// ***********************
async function findWooProductBySku(sku) {
	console.log(
		`[${new Date().toISOString()}] [findWooProductBySku] Ищем товар с SKU: ${sku}`
	)
	try {
		const url = `${process.env.WC_API_URL}/products`
		console.log(
			`[${new Date().toISOString()}] [findWooProductBySku] Запрос: GET ${url} с параметрами:`,
			{ sku }
		)
		const resp = await axios.get(url, {
			auth: {
				username: process.env.WC_CONSUMER_KEY,
				password: process.env.WC_CONSUMER_SECRET,
			},
			params: { sku },
		})
		console.log(
			`[${new Date().toISOString()}] [findWooProductBySku] Ответ от WooCommerce:`,
			resp.data
		)
		if (Array.isArray(resp.data) && resp.data.length > 0) {
			console.log(
				`[${new Date().toISOString()}] [findWooProductBySku] Найден товар: ${
					resp.data[0].name
				}`
			)
			return resp.data[0]
		}
		console.warn(
			`[${new Date().toISOString()}] [findWooProductBySku] Товар с SKU ${sku} не найден.`
		)
		return null
	} catch (e) {
		console.error(
			`[${new Date().toISOString()}] [findWooProductBySku] Ошибка запроса:`,
			e
		)
		return null
	}
}

// ***********************
// Эндпоинт для создания заказа через CLICK
// ***********************
app.post('/create-click-order', async (req, res) => {
	console.log(
		`[${new Date().toISOString()}] [create-click-order] Получен заказ. Тело запроса:`,
		req.body
	)
	const { chat_id, cart, phone_number, lang } = req.body
	if (
		!chat_id ||
		!cart ||
		!Array.isArray(cart) ||
		cart.length === 0 ||
		!phone_number
	) {
		console.error(
			`[${new Date().toISOString()}] [create-click-order] Некорректные данные:`,
			req.body
		)
		return res
			.status(400)
			.json({ success: false, error: 'Некорректные данные' })
	}
	const clientName = req.body.name || 'Пользователь'
	let lineItems = []
	let totalAmount = 0
	for (const item of cart) {
		console.log(
			`[${new Date().toISOString()}] [create-click-order] Обработка товара:`,
			item
		)
		if (!item.sku) {
			console.warn(
				`[${new Date().toISOString()}] [create-click-order] Товар "${
					item.name
				}" не содержит SKU. Пропускаем.`
			)
			continue
		}
		const wooProd = await findWooProductBySku(item.sku)
		if (!wooProd) {
			console.warn(
				`[${new Date().toISOString()}] [create-click-order] Товар с SKU ${
					item.sku
				} не найден в WooCommerce.`
			)
			continue
		}
		lineItems.push({
			product_id: wooProd.id,
			quantity: item.quantity,
		})
		totalAmount += item.price * item.quantity
	}
	if (lineItems.length === 0) {
		console.error(
			`[${new Date().toISOString()}] [create-click-order] Нет товаров для создания заказа.`
		)
		return res
			.status(400)
			.json({ success: false, error: 'Нет товаров для Click заказа' })
	}
	console.log(
		`[${new Date().toISOString()}] [create-click-order] Общая сумма заказа (UZS) = ${totalAmount}`
	)
	const orderData = {
		payment_method: 'clickuz',
		payment_method_title: 'CLICK',
		set_paid: false,
		billing: {
			first_name: clientName,
			last_name: ' ',
			email: 'client@example.com',
			phone: phone_number,
			address_1: 'Адрес',
			address_2: '',
			city: 'Tashkent',
			state: 'Tashkent',
			postcode: '100000',
			country: 'UZ',
		},
		line_items: lineItems,
	}
	try {
		const wcResp = await axios.post(
			`${process.env.WC_API_URL}/orders`,
			orderData,
			{
				auth: {
					username: process.env.WC_CONSUMER_KEY,
					password: process.env.WC_CONSUMER_SECRET,
				},
			}
		)
		const wcOrder = wcResp.data
		const order_id = wcOrder.id
		const order_key = wcOrder.order_key
		const wcTotal = parseFloat(wcOrder.total || '0')
		console.log(
			`[${new Date().toISOString()}] [create-click-order] WooCommerce заказ #${order_id}, order_key=${order_key}, total=${wcTotal}`
		)
		const siteUrl = process.env.WC_SITE_URL || 'https://mrclub.uz'
		const payUrl = `${siteUrl}/checkout/order-pay/${order_id}/?key=${order_key}&order_pay=${order_id}`
		const merchant_trans_id = `click_${Date.now()}`
		const insertQuery = `
      INSERT INTO orders (merchant_trans_id, chat_id, totalAmount, status, lang, cart, wc_order_id, wc_order_key)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `
		try {
			await pool.query(insertQuery, [
				merchant_trans_id,
				chat_id,
				totalAmount,
				'CREATED',
				lang || 'ru',
				JSON.stringify(cart),
				order_id,
				order_key,
			])
			// Здесь можно использовать готовые переводы из вашей системы, если они подключены
			const txt = (
				lang === 'uz'
					? "📦 Buyurtma №{{merchant_trans_id}}\n💰 Jami: {{amount}} UZS\n🔗 Iltimos, to'lang:\n{{url}}"
					: '📦 Заказ №{{merchant_trans_id}}\n💰 Сумма: {{amount}} UZS\n🔗 Оплатите по ссылке:\n{{url}}'
			)
				.replace('{{merchant_trans_id}}', merchant_trans_id)
				.replace('{{amount}}', totalAmount)
				.replace('{{url}}', payUrl)
			bot.telegram
				.sendMessage(chat_id, txt)
				.catch(e => console.error('Ошибка Telegram (Click):', e))
			return res.json({ success: true, clickLink: payUrl })
		} catch (err) {
			console.error(
				`[${new Date().toISOString()}] [create-click-order] Ошибка сохранения заказа в БД:`,
				err
			)
			return res.status(500).json({
				success: false,
				error: 'Ошибка при создании заказа WooCommerce',
			})
		}
	} catch (e) {
		console.error(
			`[${new Date().toISOString()}] [create-click-order] Ошибка WooCommerce (create order):`,
			e.response?.data || e.message
		)
		return res
			.status(500)
			.json({ success: false, error: 'Ошибка при создании заказа WooCommerce' })
	}
})

// ***********************
// Эндпоинт для создания заказа через PAYME
// ***********************
app.post('/create-payme-order', async (req, res) => {
	console.log(
		`[${new Date().toISOString()}] [create-payme-order] Получен заказ. Тело запроса:`,
		req.body
	)
	const { chat_id, cart, phone_number, lang } = req.body
	if (
		!chat_id ||
		!cart ||
		!Array.isArray(cart) ||
		cart.length === 0 ||
		!phone_number
	) {
		console.error(
			`[${new Date().toISOString()}] [create-payme-order] Некорректные данные:`,
			req.body
		)
		return res
			.status(400)
			.json({ success: false, error: 'Некорректные данные' })
	}
	let lineItems = []
	let totalAmount = 0
	for (const item of cart) {
		console.log(
			`[${new Date().toISOString()}] [create-payme-order] Обработка товара:`,
			item
		)
		if (!item.sku) {
			console.warn(
				`[${new Date().toISOString()}] [create-payme-order] Товар "${
					item.name
				}" не содержит SKU. Пропускаем.`
			)
			continue
		}
		const wooProd = await findWooProductBySku(item.sku)
		if (!wooProd) {
			console.warn(
				`[${new Date().toISOString()}] [create-payme-order] Товар с SKU ${
					item.sku
				} не найден в WooCommerce.`
			)
			continue
		}
		lineItems.push({
			product_id: wooProd.id,
			quantity: item.quantity,
		})
		totalAmount += item.price * item.quantity
	}
	if (lineItems.length === 0) {
		console.error(
			`[${new Date().toISOString()}] [create-payme-order] Нет товаров для создания заказа.`
		)
		return res
			.status(400)
			.json({ success: false, error: 'Нет товаров для Payme заказа' })
	}
	console.log(
		`[${new Date().toISOString()}] [create-payme-order] Общая сумма заказа (UZS) = ${totalAmount}`
	)
	const orderData = {
		payment_method: 'payme',
		payment_method_title: 'Payme',
		set_paid: false,
		billing: {
			first_name: 'Тест',
			last_name: 'Клиент',
			address_1: 'Тестовый адрес',
			city: 'Tashkent',
			state: 'Tashkent',
			postcode: '100000',
			country: 'UZ',
			email: 'test@example.com',
			phone: phone_number,
		},
		line_items: lineItems,
	}
	try {
		const wcResp = await axios.post(
			`${process.env.WC_API_URL}/orders`,
			orderData,
			{
				auth: {
					username: process.env.WC_CONSUMER_KEY,
					password: process.env.WC_CONSUMER_SECRET,
				},
			}
		)
		const wcOrder = wcResp.data
		const order_id = wcOrder.id
		const order_key = wcOrder.order_key
		const wcTotal = parseFloat(wcOrder.total || '0')
		console.log(
			`[${new Date().toISOString()}] [create-payme-order] WooCommerce заказ #${order_id}, order_key=${order_key}, total=${wcTotal}`
		)
		const siteUrl = process.env.WC_SITE_URL || 'https://mrclub.uz'
		const payUrl = `${siteUrl}/checkout/order-pay/${order_id}/?key=${order_key}&order_pay=${order_id}`
		const merchant_trans_id = `payme_${Date.now()}`
		const insertQuery = `
      INSERT INTO orders (merchant_trans_id, chat_id, totalAmount, status, lang, cart, wc_order_id, wc_order_key)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `
		try {
			await pool.query(insertQuery, [
				merchant_trans_id,
				chat_id,
				totalAmount,
				'CREATED',
				lang || 'ru',
				JSON.stringify(cart),
				order_id,
				order_key,
			])
			const textMsg = `Заказ №${merchant_trans_id}\nСумма: ${wcTotal} UZS\nОплатить:\n${payUrl}`
			bot.telegram
				.sendMessage(chat_id, textMsg)
				.catch(e =>
					console.error('Ошибка Telegram при отправке Payme ссылки:', e)
				)
			return res.json({ success: true, paymeLink: payUrl })
		} catch (err) {
			console.error(
				`[${new Date().toISOString()}] [create-payme-order] Ошибка сохранения заказа Payme в БД:`,
				err
			)
			return res.status(500).json({
				success: false,
				error: 'Ошибка при создании заказа WooCommerce',
			})
		}
	} catch (e) {
		console.error(
			`[${new Date().toISOString()}] [create-payme-order] Ошибка WooCommerce (create order):`,
			e.response?.data || e.message
		)
		return res
			.status(500)
			.json({ success: false, error: 'Ошибка при создании заказа WooCommerce' })
	}
})

// ***********************
// Эндпоинт для получения корзины
// ***********************
app.get('/get-car', async (req, res) => {
	const chat_id = req.query.chat_id
	if (!chat_id) {
		return res.status(400).json({ success: false, error: 'chat_id не указан' })
	}
	const query = `SELECT cart FROM carts WHERE chat_id = $1`
	try {
		const result = await pool.query(query, [chat_id])
		if (result.rows.length) {
			const row = result.rows[0]
			return res.json({ success: true, cart: row.cart })
		} else {
			return res.json({ success: true, cart: [] })
		}
	} catch (err) {
		console.error('Ошибка получения корзины из БД:', err)
		return res.status(500).json({ success: false, error: 'Ошибка сервера' })
	}
})

// ***********************
// Эндпоинт для получения заказов
// ***********************
app.get('/get-orders', async (req, res) => {
	const chat_id = req.query.chat_id
	if (!chat_id) {
		return res.status(400).json({ success: false, error: 'chat_id не указан' })
	}
	const query = `SELECT * FROM orders WHERE chat_id = $1`
	try {
		const result = await pool.query(query, [chat_id])
		const ordersWithStatus = result.rows.map(o => {
			let statusText = ''
			switch (o.status) {
				case 'CREATED':
					statusText = 'В очереди'
					break
				case 'PAID':
					statusText = 'Оплачен'
					break
				case 'CANCELED':
					statusText = 'Отменён'
					break
				default:
					statusText = o.status
			}
			return { ...o, statusText }
		})
		return res.json({ success: true, orders: ordersWithStatus })
	} catch (err) {
		console.error('Ошибка получения заказов из БД:', err)
		return res.status(500).json({ success: false, error: 'Ошибка сервера' })
	}
})

// ***********************
// Эндпоинт для очистки заказов
// ***********************
app.post('/clear-orders', async (req, res) => {
	const { chat_id } = req.body
	if (!chat_id) {
		return res.status(400).json({ success: false, error: 'chat_id не указан' })
	}
	const query = `DELETE FROM orders WHERE chat_id = $1`
	try {
		await pool.query(query, [chat_id])
		return res.json({ success: true, message: `Заказы очищены.` })
	} catch (err) {
		console.error('Ошибка очистки заказов:', err)
		return res.status(500).json({ success: false, error: 'Ошибка сервера' })
	}
})

// ***********************
// Self-ping (для предотвращения простоя, например, на Render.com)
// ***********************
if (process.env.RENDER_EXTERNAL_URL) {
	cron.schedule('*/10 * * * *', async () => {
		try {
			await axios.get(process.env.RENDER_EXTERNAL_URL)
			console.log('Self-ping: приложение активно.')
		} catch (error) {
			console.error('Self-ping: ошибка запроса:', error.message)
		}
	})
}

// ***********************
// Запуск сервера и бота
// ***********************
app.listen(PORT, () => {
	console.log(`🚀 Сервер запущен на порту ${PORT}`)
})

bot
	.launch()
	.then(() => console.log('Telegram-бот запущен'))
	.catch(err => console.error('Ошибка запуска Telegram-бота:', err))

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
