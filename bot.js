// bot.js
const express = require('express')
const { Telegraf, Markup } = require('telegraf')
const axios = require('axios')
const path = require('path')
const dotenv = require('dotenv')

// Загрузка переменных окружения
dotenv.config()

// Инициализация Express
const app = express()
const PORT = process.env.PORT || 3000

// Инициализация Telegram-бота
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN)

// Middleware для парсинга JSON
app.use(express.json())

// Обслуживание статических файлов (Web App)
app.use(express.static(path.join(__dirname, 'public')))

// Функция для получения JWT-токена
const getJwtToken = async () => {
	try {
		const response = await axios.post(
			process.env.BILLZ_AUTH_URL,
			{ secret_token: process.env.BILLZ_SECRET_TOKEN },
			{
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
			}
		)

		if (response.status === 200) {
			const token = response.data.data.access_token
			console.log('Получен JWT токен:', token)
			return token
		} else {
			console.error('Ошибка авторизации:', response.status, response.data)
			return null
		}
	} catch (error) {
		console.error('Ошибка при получении JWT токена:', error)
		return null
	}
}

// Функция для получения всех товаров
const getAllProducts = async jwtToken => {
	try {
		let allProducts = []
		let limit = 100 // Лимит товаров на запрос
		let page = 1

		while (true) {
			const response = await axios.get(process.env.BILLZ_PRODUCTS_URL, {
				headers: {
					Accept: 'application/json',
					Authorization: `Bearer ${jwtToken}`,
				},
				params: {
					limit: limit,
					page: page,
				},
			})

			if (response.status === 200) {
				const data = response.data
				const products = data.products

				if (!products || !Array.isArray(products) || products.length === 0) {
					break
				}

				// Фильтрация товаров по shop_measurement_values
				const filteredProducts = products
					.filter(
						product =>
							product.shop_measurement_values &&
							Array.isArray(product.shop_measurement_values) &&
							product.shop_measurement_values.some(
								sm => sm.shop_id === process.env.DESIRED_SHOP_ID
							)
					)
					.map(product => {
						// Получаем shop_measurement_values для нужного магазина
						const shopMeasurement = product.shop_measurement_values.find(
							sm => sm.shop_id === process.env.DESIRED_SHOP_ID
						)
						const priceObj = product.shop_prices.find(
							p =>
								p.shop_id === process.env.DESIRED_SHOP_ID &&
								p.retail_currency === 'UZS'
						)
						const price = priceObj ? priceObj.retail_price : 0

						return {
							id: product.id,
							name: product.name || 'Без названия',
							brand_name: product.brand_name || 'Неизвестный бренд',
							price: price,
							qty: shopMeasurement
								? shopMeasurement.active_measurement_value
								: 0,
							shop_name: shopMeasurement
								? shopMeasurement.shop_name
								: 'Unknown Shop',
							main_image_url_full: product.main_image_url_full || '',
							photos: product.photos
								? product.photos.map(photo => photo.photo_url)
								: [],
						}
					})

				allProducts = [...allProducts, ...filteredProducts]
				console.log(
					`Страница ${page}: Получено ${filteredProducts.length} товаров`
				)
				page += 1
			} else {
				console.error(
					'Ошибка при получении товаров:',
					response.status,
					response.data
				)
				break
			}
		}

		console.log(`Всего получено товаров: ${allProducts.length}`)
		return allProducts
	} catch (error) {
		console.error('Ошибка при получении товаров:', error)
		return []
	}
}

// Обработка API-запроса для получения товаров
app.get('/api/products', async (req, res) => {
	const token = await getJwtToken()
	if (token) {
		const products = await getAllProducts(token)
		res.json(products)
	} else {
		res.status(500).json({ error: 'Не удалось получить токен авторизации' })
	}
})

// Обработка команды /start
bot.start(async ctx => {
	await ctx.reply('Привет! Как вас зовут? 😊')

	bot.on('text', async ctx => {
		const name = ctx.message.text

		if (name) {
			await ctx.reply(
				`Приятно познакомиться, ${name}! Отправьте, пожалуйста, свой контакт для продолжения.`,
				Markup.keyboard([
					Markup.button.contactRequest('Отправить контакт'),
				]).resize()
			)

			bot.on('contact', async ctx => {
				const contact = ctx.message.contact
				if (contact) {
					await ctx.reply(
						`Спасибо, ${name}! Ваш номер ${contact.phone_number} сохранен. Нажмите "📚 Каталог", чтобы начать.`,
						Markup.keyboard([
							['📚 Каталог', '🛒 Корзина'],
							['📦 Заказы'],
						]).resize()
					)
				} else {
					await ctx.reply('Пожалуйста, отправьте свой контакт.')
				}
			})
		} else {
			await ctx.reply('Пожалуйста, введите ваше имя. ✍️')
		}
	})
})

// Обработка нажатия кнопки "📚 Каталог"
bot.hears('📚 Каталог', async ctx => {
	await ctx.reply(
		'Открываю каталог товаров...',
		Markup.inlineKeyboard([
			[Markup.button.webApp('Открыть каталог', process.env.WEBAPP_URL)],
		])
	)
})

// Обработка нажатия кнопки "🛒 Корзина"
bot.hears('🛒 Корзина', async ctx => {
	await ctx.reply('Ваша корзина пуста.')
})

// Обработка нажатия кнопки "📦 Заказы"
bot.hears('📦 Заказы', async ctx => {
	await ctx.reply('История заказов пока недоступна.')
})

// Обработка данных из Web App
bot.on('web_app_data', async ctx => {
	try {
		const data = JSON.parse(ctx.message.web_app_data.data)
		if (data.action === 'add' && data.product_id) {
			await ctx.reply(`Товар с ID ${data.product_id} добавлен в корзину.`)
		} else {
			await ctx.reply('Некорректные данные.')
		}
	} catch (error) {
		console.error('Ошибка обработки web_app_data:', error)
		await ctx.reply('Произошла ошибка при обработке данных.')
	}
})

// Запуск сервера Express
app.listen(PORT, () => {
	console.log(`Сервер запущен на порту ${PORT}`)
})

// Запуск бота
bot
	.launch()
	.then(() => console.log('Telegram-бот запущен'))
	.catch(err => console.error('Ошибка запуска Telegram-бота:', err))

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
